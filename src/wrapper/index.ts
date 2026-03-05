#!/usr/bin/env node
// Shell wrapper — sits between the user and the real tool binary.
// Resolves the project, sets env vars, spawns MCP server + real tool,
// and triggers session end on exit.

import { spawn } from "node:child_process";
import { accessSync, constants, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { v4 as uuid } from "uuid";
import type { SessionOutcome } from "../types/index.js";
import { detectTool } from "./detect.js";
import { resolveProject } from "./project.js";
import { handleEndSession, seedBuffers, getMessageBuffer, getEventBuffer } from "../mcp/handlers.js";
import { loadEmbedder } from "../db/embedding.js";
import { getSessionById, deleteSession, db, getProjectById } from "../db/index.js";
import { classifyToolEvent } from "../layer1/events.js";
import { readCodexSession } from "./codex.js";
import { readClaudeSession } from "./claude.js";
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
  exitCode: number | null,
  tool: string,
  cwd: string,
  sessionStartMs: number
): Promise<void> {
  // For Codex: read session data from its own storage (no MCP/hooks)
  if ((tool as string) === "codex") {
    const codexData = readCodexSession(cwd, sessionStartMs);
    if (codexData) {
      const extractedEvents = codexData.events
        .map(e => classifyToolEvent(e.tool, e.args, e.result, e.success))
        .filter((e): e is NonNullable<typeof e> => e !== null)
        .map(e => ({ ...e, session_id: sessionId as UUID }));
      seedBuffers(sessionId, codexData.messages, extractedEvents);
    }
  }

  // For Claude: read JSONL to fill in messages (MCP only captures tool events,
  // not conversation messages). Also fill in events if hooks captured nothing.
  if ((tool as string) === "claude") {
    const claudeData = readClaudeSession(cwd, sessionId, sessionStartMs);
    if (claudeData) {
      const eventCount = (db.prepare<[string], { count: number }>(
        "SELECT COUNT(*) as count FROM events WHERE session_id = ?"
      ).get(sessionId) ?? { count: 0 }).count;

      // Always use messages from JSONL (MCP store_message is rarely configured)
      // Only use events from JSONL if hooks captured nothing
      const eventsToSeed = eventCount === 0
        ? claudeData.events
            .map(e => classifyToolEvent(e.tool, e.args, e.result, e.success))
            .filter((e): e is NonNullable<typeof e> => e !== null)
            .map(e => ({ ...e, session_id: sessionId as UUID }))
        : [];

      seedBuffers(sessionId, claudeData.messages, eventsToSeed);
    }
  }

  // Minimum viable session guard: skip trivial sessions (no buffered data and very short)
  const session = getSessionById(sessionId as UUID);
  if (session) {
    const durationSeconds = Math.round((Date.now() - session.started_at) / 1000);
    const eventCount = (db.prepare<[string], { count: number }>(
      "SELECT COUNT(*) as count FROM events WHERE session_id = ?"
    ).get(sessionId) ?? { count: 0 }).count;
    const hasBufferedData = getMessageBuffer(sessionId).length > 0 || getEventBuffer(sessionId).length > 0;
    if (!hasBufferedData && eventCount === 0 && durationSeconds < 30) {
      try { deleteSession(sessionId as UUID); } catch { /* best-effort */ }
      return;
    }
  }

  // MCP sidecar loads the embedder for Claude, but since we now run the pipeline
  // directly in the wrapper for all tools, always ensure embedder is loaded.
  try { await loadEmbedder(); } catch { /* best-effort */ }

  await handleEndSession({ session_id: sessionId, project_id: projectId, outcome, exit_code: exitCode });
}

// ─── injectCodexContext ───────────────────────────────────────────────────────

const AGENTS_MD_HEADER = "<!-- llm-memory: auto-generated, do not edit -->\n";

export function injectCodexContext(cwd: string, projectId: string): void {
  const project = getProjectById(projectId as UUID);
  if (!project?.memory_doc) return;

  const agentsPath = join(cwd, "AGENTS.md");

  // If AGENTS.md exists and wasn't written by us, prepend our section
  let existing = "";
  if (existsSync(agentsPath)) {
    const content = readFileSync(agentsPath, "utf8");
    // Already injected — replace our section
    if (content.startsWith(AGENTS_MD_HEADER)) {
      const markerEnd = content.indexOf("\n<!-- /llm-memory -->");
      existing = markerEnd >= 0 ? content.slice(markerEnd + "\n<!-- /llm-memory -->".length) : "";
    } else {
      existing = "\n" + content;
    }
  }

  const injected =
    AGENTS_MD_HEADER +
    "# Project Memory (from previous sessions)\n\n" +
    project.memory_doc.trim() +
    "\n<!-- /llm-memory -->" +
    existing;

  writeFileSync(agentsPath, injected, "utf8");
}

// ─── main ─────────────────────────────────────────────────────────────────────

export async function main(): Promise<void> {
  const tool = detectTool();
  const cwd = process.cwd();
  const { projectId } = await resolveProject(cwd);
  const sessionId = uuid();
  const sessionStartMs = Date.now();

  process.env["LLM_MEMORY_SESSION_ID"] = sessionId;
  process.env["LLM_MEMORY_PROJECT_ID"] = projectId;

  // Inject project memory into AGENTS.md for Codex and OpenCode (both read it at startup)
  if ((tool as string) === "codex" || (tool as string) === "opencode") {
    try { injectCodexContext(cwd, projectId); } catch { /* best-effort */ }
  }

  // Spawn MCP server as a side-car child process — only for Claude Code,
  // which is the only tool that supports MCP. Other tools (codex, gemini,
  // opencode) don't use MCP, and StdioServerTransport would steal stdin
  // from the child process and corrupt the terminal.
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const mcpScript = join(__dirname, "..", "mcp", "index.js");
  const mcpProc = (tool as string) === "claude"
    ? spawn(process.execPath, [mcpScript], {
        stdio: ["ignore", "ignore", "inherit"],
        env: { ...process.env },
      })
    : null;

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
  process.on("SIGHUP", () => toolProc.kill("SIGHUP"));

  toolProc.on("exit", async (code, signal) => {
    const outcome = resolveOutcome(code, signal);
    try {
      await signalSessionEnd(sessionId, projectId, outcome, code, tool as string, cwd, sessionStartMs);
    } catch (e) {
      console.error("[llm-memory] session end failed:", e);
    }
    mcpProc?.kill();
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
