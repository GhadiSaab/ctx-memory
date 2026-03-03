#!/usr/bin/env node
// Shell wrapper — sits between the user and the real tool binary.
// Resolves the project, sets env vars, spawns MCP server + real tool,
// and triggers session end on exit.

import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { v4 as uuid } from "uuid";
import type { SessionOutcome } from "../types/index.js";
import { detectTool } from "./detect.js";
import { resolveProject } from "./project.js";
import { handleEndSession } from "../mcp/handlers.js";
import { getSessionById, deleteSession, db } from "../db/index.js";
import type { UUID } from "../types/index.js";

// ─── resolveOutcome ───────────────────────────────────────────────────────────

export function resolveOutcome(
  code: number | null,
  signal: string | null
): SessionOutcome {
  if (signal) return "interrupted";
  if (code === 0) return "completed";
  if (code === 130) return "interrupted";
  return "crashed";
}

// ─── findRealBinary ───────────────────────────────────────────────────────────

const LLM_MEMORY_BIN = join(homedir(), ".llm-memory", "bin");

export function findRealBinary(toolName: string, pathDirs: string[]): string {
  for (const dir of pathDirs) {
    // Skip our own shim directory to avoid infinite recursion
    if (dir === LLM_MEMORY_BIN || dir.includes(".llm-memory/bin")) continue;
    const candidate = join(dir, toolName);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not found or not executable — try next
    }
  }
  throw new Error(`[llm-memory] Cannot find real '${toolName}' binary in PATH (excluding ${LLM_MEMORY_BIN})`);
}

// ─── signalSessionEnd ─────────────────────────────────────────────────────────

async function signalSessionEnd(
  sessionId: string,
  projectId: string,
  outcome: SessionOutcome,
  exitCode: number | null
): Promise<void> {
  // Minimum viable session guard: skip trivial sessions (no events and very short)
  const session = getSessionById(sessionId as UUID);
  if (session) {
    const durationSeconds = Math.round((Date.now() - session.started_at) / 1000);
    const eventCount = (db.prepare<[string], { count: number }>(
      "SELECT COUNT(*) as count FROM events WHERE session_id = ?"
    ).get(sessionId) ?? { count: 0 }).count;
    if (eventCount === 0 && durationSeconds < 30) {
      try { deleteSession(sessionId as UUID); } catch { /* best-effort */ }
      return;
    }
  }

  await handleEndSession({ session_id: sessionId, project_id: projectId, outcome, exit_code: exitCode });
}

// ─── main ─────────────────────────────────────────────────────────────────────

export async function main(): Promise<void> {
  const tool = detectTool();
  const cwd = process.cwd();
  const { projectId } = await resolveProject(cwd);
  const sessionId = uuid();

  process.env["LLM_MEMORY_SESSION_ID"] = sessionId;
  process.env["LLM_MEMORY_PROJECT_ID"] = projectId;

  // Spawn MCP server as a side-car child process
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const mcpScript = join(__dirname, "..", "mcp", "index.js");
  const mcpProc = spawn(process.execPath, [mcpScript], {
    stdio: ["ignore", "ignore", "inherit"],
    env: { ...process.env },
  });

  // Find and spawn the real tool binary
  const pathDirs = (process.env["PATH"] ?? "").split(":");
  const realBin = findRealBinary(tool, pathDirs);
  const toolArgs = process.argv.slice(2); // forward all args after the script name
  const toolProc = spawn(realBin, toolArgs, {
    stdio: "inherit",
    env: { ...process.env },
  });

  // Forward signals to the real tool
  process.on("SIGINT", () => toolProc.kill("SIGINT"));
  process.on("SIGTERM", () => toolProc.kill("SIGTERM"));

  toolProc.on("exit", async (code, signal) => {
    const outcome = resolveOutcome(code, signal);
    try {
      await signalSessionEnd(sessionId, projectId, outcome, code);
    } catch (e) {
      console.error("[llm-memory] session end failed:", e);
    }
    mcpProc.kill();
    process.exit(code ?? 0);
  });
}

// ─── Entrypoint ───────────────────────────────────────────────────────────────

if (!process.env["VITEST"]) {
  main().catch((e) => {
    console.error("[llm-memory] wrapper fatal error:", e);
    process.exit(1);
  });
}
