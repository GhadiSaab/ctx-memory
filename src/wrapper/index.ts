#!/usr/bin/env node
// Shell wrapper — sits between the user and the real tool binary.
// Resolves the project, sets env vars, spawns MCP server + real tool,
// and triggers session end on exit.

import { spawn, execFileSync } from "node:child_process";
import { accessSync, constants, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { v4 as uuid } from "uuid";
import type { SessionOutcome, ToolName } from "../types/index.js";
import { detectTool } from "./detect.js";
import { resolveProject } from "./project.js";
import { handleEndSession, seedBuffers, getMessageBuffer, getEventBuffer } from "../mcp/handlers.js";
import { loadEmbedder } from "../db/embedding.js";
import { getSessionById, deleteSession, db, getProjectById, createSession } from "../db/index.js";
import { classifyToolEvent } from "../layer1/events.js";
import { readCodexSession } from "./codex.js";
import { readClaudeSession } from "./claude.js";
import { readOpenCodeSession } from "./opencode.js";
import { readGeminiSession } from "./gemini.js";
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

export function normalizeToolName(tool: string): ToolName {
  if ((tool as string) === "claude") return "claude-code";
  return tool as ToolName;
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
  if (tool === "codex") {
    const codexData = readCodexSession(cwd, sessionStartMs);
    if (codexData) {
      const stampedMessages = codexData.messages.map(m => ({ ...m, session_id: sessionId as UUID }));
      const extractedEvents = codexData.events
        .map(e => classifyToolEvent(e.tool, e.args, e.result, e.success))
        .filter((e): e is NonNullable<typeof e> => e !== null)
        .map(e => ({ ...e, session_id: sessionId as UUID }));
      seedBuffers(sessionId, stampedMessages, extractedEvents);
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

      const eventsToSeed = eventCount === 0
        ? claudeData.events
            .map(e => classifyToolEvent(e.tool, e.args, e.result, e.success))
            .filter((e): e is NonNullable<typeof e> => e !== null)
            .map(e => ({ ...e, session_id: sessionId as UUID }))
        : [];

      seedBuffers(sessionId, claudeData.messages, eventsToSeed);
    }
  }

  // For OpenCode: read its local SQLite store post-hoc.
  if (tool === "opencode") {
    const openCodeData = readOpenCodeSession(cwd, sessionStartMs);
    if (openCodeData) {
      const eventCount = (db.prepare<[string], { count: number }>(
        "SELECT COUNT(*) as count FROM events WHERE session_id = ?"
      ).get(sessionId) ?? { count: 0 }).count;

      const stampedMessages = openCodeData.messages.map(m => ({ ...m, session_id: sessionId as UUID }));
      const eventsToSeed = eventCount === 0
        ? openCodeData.events
            .map(e => classifyToolEvent(e.tool, e.args, e.result, e.success))
            .filter((e): e is NonNullable<typeof e> => e !== null)
            .map(e => ({ ...e, session_id: sessionId as UUID }))
        : [];

      seedBuffers(sessionId, stampedMessages, eventsToSeed);
    }
  }

  // For Gemini: read session JSONL post-hoc. Hooks may not fire in non-interactive
  // mode, so the post-session reader is the reliable data source.
  if (tool === "gemini") {
    const geminiData = readGeminiSession(cwd, sessionStartMs);
    if (geminiData) {
      const eventCount = (db.prepare<[string], { count: number }>(
        "SELECT COUNT(*) as count FROM events WHERE session_id = ?"
      ).get(sessionId) ?? { count: 0 }).count;

      const stampedMessages = geminiData.messages.map(m => ({ ...m, session_id: sessionId as UUID }));
      const eventsToSeed = eventCount === 0
        ? geminiData.events
            .map(e => classifyToolEvent(e.tool, e.args, e.result, e.success))
            .filter((e): e is NonNullable<typeof e> => e !== null)
            .map(e => ({ ...e, session_id: sessionId as UUID }))
        : [];

      seedBuffers(sessionId, stampedMessages, eventsToSeed);
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

  try { await loadEmbedder(); } catch { /* best-effort */ }

  await handleEndSession({
    session_id: sessionId,
    project_id: projectId,
    tool: normalizeToolName(tool),
    outcome,
    exit_code: exitCode,
  });
}

// ─── Context injection ────────────────────────────────────────────────────────

const AGENTS_MD_HEADER = "<!-- llm-memory: auto-generated, do not edit -->\n";

function injectMarkdownContext(filePath: string, projectId: string): void {
  const project = getProjectById(projectId as UUID);
  if (!project?.memory_doc) return;

  let existing = "";
  if (existsSync(filePath)) {
    const content = readFileSync(filePath, "utf8");
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

  writeFileSync(filePath, injected, "utf8");
}

export function injectCodexContext(cwd: string, projectId: string): void {
  injectMarkdownContext(join(cwd, "AGENTS.md"), projectId);
}

export function injectGeminiContext(cwd: string, projectId: string): void {
  injectMarkdownContext(join(cwd, "GEMINI.md"), projectId);
}

// ─── Non-interactive subcommands (bypass wrapper entirely) ───────────────────

const BYPASS_SUBCOMMANDS: Record<string, ReadonlySet<string>> = {
  claude:   new Set(["mcp", "doctor", "update", "login", "logout", "config", "completion", "migrate"]),
  codex:    new Set(["login", "logout", "mcp", "mcp-server", "completion", "debug", "apply", "resume",
                     "fork", "cloud", "features", "review", "sandbox", "app-server"]),
  opencode: new Set(["update", "upgrade", "uninstall", "auth", "mcp", "completion", "debug", "acp",
                     "serve", "web", "models", "stats", "export", "import", "github", "pr",
                     "session", "db", "agent"]),
  gemini:   new Set(["update", "login", "logout", "completion"]),
};

function shouldBypass(tool: string, args: string[]): boolean {
  const sub = args[0];
  if (!sub || sub.startsWith("-")) return false;
  return BYPASS_SUBCOMMANDS[tool]?.has(sub) ?? false;
}

// ─── main ─────────────────────────────────────────────────────────────────────

export async function main(): Promise<void> {
  const tool = detectTool();
  const toolArgs = process.argv.slice(2);

  // Bypass: non-interactive subcommands go straight to the real binary
  if (shouldBypass(tool, toolArgs)) {
    const pathDirs = (process.env["PATH"] ?? "").split(":");
    const realBin = findRealBinary(tool, pathDirs);
    try {
      execFileSync(realBin, toolArgs, { stdio: "inherit" });
      process.exit(0);
    } catch (e: unknown) {
      process.exit((e as NodeJS.ErrnoException & { status?: number }).status ?? 1);
    }
  }

  const cwd = process.cwd();
  const { projectId } = await resolveProject(cwd);
  const sessionId = uuid();
  const sessionStartMs = Date.now();

  process.env["LLM_MEMORY_SESSION_ID"] = sessionId;
  process.env["LLM_MEMORY_PROJECT_ID"] = projectId;

  createSession({
    id: sessionId as UUID,
    project_id: projectId as UUID,
    tool: normalizeToolName(tool),
  });

  // Inject project memory at startup
  if (tool === "codex" || tool === "opencode") {
    try { injectCodexContext(cwd, projectId); } catch { /* best-effort */ }
  }
  if (tool === "gemini") {
    try { injectGeminiContext(cwd, projectId); } catch { /* best-effort */ }
  }

  // For Claude: write a temp MCP config and inject --mcp-config
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const mcpScript = join(__dirname, "..", "mcp", "index.js");
  let mcpConfigPath: string | null = null;
  let finalToolArgs = toolArgs;

  if ((tool as string) === "claude") {
    mcpConfigPath = join(homedir(), ".llm-memory", `session-${sessionId}.mcp.json`);
    const mcpConfig = {
      mcpServers: {
        "llm-memory": {
          command: process.execPath,
          args: [mcpScript],
        },
      },
    };
    writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig), "utf8");
    finalToolArgs = ["--mcp-config", mcpConfigPath, ...toolArgs];
  }

  // OpenCode: spawn MCP sidecar
  const mcpProc = tool === "opencode"
    ? spawn(process.execPath, [mcpScript], {
        stdio: ["ignore", "ignore", "inherit"],
        env: { ...process.env },
      })
    : null;

  // Find and spawn the real tool binary
  const pathDirs = (process.env["PATH"] ?? "").split(":");
  const realBin = findRealBinary(tool, pathDirs);
  const toolProc = spawn(realBin, finalToolArgs, {
    stdio: "inherit",
    env: { ...process.env },
  });

  // Forward signals to the real tool
  process.on("SIGINT", () => toolProc.kill("SIGINT"));
  process.on("SIGTERM", () => toolProc.kill("SIGTERM"));
  process.on("SIGHUP", () => toolProc.kill("SIGHUP"));

  toolProc.on("exit", async (code, signal) => {
    const outcome = resolveOutcome(code, signal);

    if (mcpConfigPath) {
      try { rmSync(mcpConfigPath); } catch { /* best-effort */ }
    }

    try {
      await signalSessionEnd(sessionId, projectId, outcome, code, tool, cwd, sessionStartMs);
    } catch (e) {
      console.error("[llm-memory] session end failed:", e);
    }
    mcpProc?.kill();
    process.exit(code ?? 0);
  });
}

// ─── Entrypoint ───────────────────────────────────────────────────────────────

import { realpathSync as _realpathSync } from "node:fs";
const _realArgv1 = (() => { try { return _realpathSync(process.argv[1] ?? ""); } catch { return process.argv[1] ?? ""; } })();
const _isWrapperEntry = !_realArgv1.endsWith("/cli/index.js") && !_realArgv1.endsWith("/cli/index.ts");

if (!process.env["VITEST"] && _isWrapperEntry) {
  main().catch((e) => {
    console.error("[llm-memory] wrapper fatal error:", e);
    process.exit(1);
  });
}
