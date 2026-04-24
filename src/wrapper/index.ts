#!/usr/bin/env node
// Shell wrapper — sits between the user and the real tool binary.
// Resolves the project, sets env vars, spawns MCP server + real tool,
// and triggers session end on exit.

import { spawn, execFileSync, execSync } from "node:child_process";
import { accessSync, constants, writeFileSync, existsSync, readFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
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
import { readAntigravitySession } from "./antigravity.js";
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
  if (tool === "claude") return "claude-code";
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
  if ((tool as string) === "codex") {
    const codexData = readCodexSession(cwd, sessionStartMs);
    if (codexData) {
      // Restamp messages with the wrapper's sessionId — Codex embeds its own thread UUID
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

  // For OpenCode: read its local SQLite store post-hoc. This captures prompts,
  // assistant messages, and tool events even when plugin hooks do not inherit
  // the wrapper's session environment.
  if ((tool as string) === "opencode") {
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
  if ((tool as string) === "gemini") {
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

  // For Antigravity: read session data from state.vscdb post-hoc
  if ((tool as string) === "antigravity") {
    try {
      const { messages } = await readAntigravitySession(cwd, sessionStartMs);
      if (messages.length > 0) {
        const stampedMessages = messages.map(m => ({ ...m, session_id: sessionId as UUID }));
        seedBuffers(sessionId, stampedMessages, []);
      }
    } catch { /* best-effort */ }
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

  await handleEndSession({
    session_id: sessionId,
    project_id: projectId,
    tool: normalizeToolName(tool),
    outcome,
    exit_code: exitCode,
  });
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

export function injectGeminiContext(cwd: string, projectId: string): void {
  const project = getProjectById(projectId as UUID);
  if (!project?.memory_doc) return;

  const geminiMdPath = join(cwd, "GEMINI.md");

  let existing = "";
  if (existsSync(geminiMdPath)) {
    const content = readFileSync(geminiMdPath, "utf8");
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

  writeFileSync(geminiMdPath, injected, "utf8");
}

export function injectAntigravityContext(cwd: string, projectId: string, sessionId: string): void {
  const project = getProjectById(projectId as UUID);

  const content =
    "# llm-memory\n\n" +
    "Use the `llm-memory` MCP server to persist important context for this chat.\n\n" +
    "Session metadata:\n" +
    `- session_id: ${sessionId}\n` +
    `- project_id: ${projectId}\n\n` +
    "During the conversation:\n" +
    "- If you want to persist something mid-session, use `store_message` with the exact `session_id` from the header above.\n\n" +
    "At session end:\n" +
    "- Do not call `end_session` manually when the Antigravity process is exiting; the llm-memory wrapper will finalize the session automatically.\n\n" +
    "Project memory from previous sessions. Treat this as background context.\n\n" +
    (project?.memory_doc?.trim() ? project.memory_doc.trim() + "\n" : "") +
    "\n";

  // Primary: .windsurf/rules/llm-memory.md (what Antigravity actually reads)
  const windsurfRulesDir = join(cwd, ".windsurf", "rules");
  mkdirSync(windsurfRulesDir, { recursive: true });
  writeFileSync(join(windsurfRulesDir, "llm-memory.md"), content, "utf8");

  // Fallback: .agent/rules/llm-memory.md
  const agentRulesDir = join(cwd, ".agent", "rules");
  mkdirSync(agentRulesDir, { recursive: true });
  writeFileSync(join(agentRulesDir, "llm-memory.md"), content, "utf8");
}

// ─── findAntigravityElectronPid ───────────────────────────────────────────────

export function findAntigravityElectronPid(
  cwd: string,
  processList?: () => Array<{ pid: number; cmd: string }>
): number | null {
  try {
    let procs: Array<{ pid: number; cmd: string }>;

    if (processList) {
      procs = processList();
    } else if (process.platform === "linux") {
      // Read /proc/*/cmdline to enumerate processes
      procs = [];
      let entries: string[];
      try {
        entries = readdirSync("/proc");
      } catch {
        return null;
      }
      for (const entry of entries) {
        const pid = parseInt(entry, 10);
        if (isNaN(pid)) continue;
        try {
          const cmdlineRaw = readFileSync(`/proc/${pid}/cmdline`, "utf8");
          // cmdline uses null bytes as argument separators — replace with spaces
          const cmd = cmdlineRaw.replace(/\0/g, " ").trim();
          procs.push({ pid, cmd });
        } catch {
          // process may have exited or we lack permission — skip
        }
      }
    } else {
      // Other platforms: parse `ps aux`
      const output = execSync("ps aux", { encoding: "utf8" });
      procs = [];
      for (const line of output.split("\n").slice(1)) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 11) continue;
        const pid = parseInt(parts[1] ?? "", 10);
        if (isNaN(pid)) continue;
        const cmd = parts.slice(10).join(" ");
        procs.push({ pid, cmd });
      }
    }

    for (const { pid, cmd } of procs) {
      // Match the main Electron process: binary path contains the antigravity install dir,
      // and it's not a child process (child processes all have --type=).
      const isAntigravityBin = cmd.includes("/share/antigravity/antigravity") ||
        cmd.includes("/.antigravity/antigravity");
      const isChildProcess = cmd.includes("--type=");
      if (isAntigravityBin && !isChildProcess) return pid;
    }

    return null;
  } catch {
    return null;
  }
}

// ─── isProcessAlive ───────────────────────────────────────────────────────────

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ESRCH") return false;
    return true; // EPERM or other: process exists, we just can't signal it
  }
}

// ─── Non-interactive subcommands (bypass wrapper entirely) ───────────────────

// These subcommands don't start an interactive session — pass them straight
// through to the real binary without any session tracking or MCP setup.
const BYPASS_SUBCOMMANDS: Record<string, ReadonlySet<string>> = {
  claude:    new Set(["mcp", "doctor", "update", "login", "logout", "config", "completion", "migrate"]),
  codex:     new Set(["login", "logout", "mcp", "mcp-server", "completion", "debug", "apply", "resume",
                      "fork", "cloud", "features", "review", "sandbox", "app-server"]),
  opencode:  new Set(["update", "upgrade", "uninstall", "auth", "mcp", "completion", "debug", "acp",
                      "serve", "web", "models", "stats", "export", "import", "github", "pr",
                      "session", "db", "agent"]),
  gemini:    new Set(["update", "login", "logout", "completion"]),
  antigravity: new Set(["serve-web", "tunnel"]),
};

const ANTIGRAVITY_OPTIONS_WITH_VALUES = new Set([
  "-d",
  "--diff",
  "-m",
  "--merge",
  "-a",
  "--add",
  "--remove",
  "-g",
  "--goto",
  "--locale",
  "--user-data-dir",
  "--profile",
  "--extensions-dir",
  "--category",
  "--install-extension",
  "--uninstall-extension",
  "--log",
  "--sync",
  "--inspect-extensions",
  "--inspect-brk-extensions",
  "--locate-shell-integration-path",
  "--add-mcp",
]);

export function findAntigravitySubcommand(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;
    if (ANTIGRAVITY_OPTIONS_WITH_VALUES.has(arg)) {
      i++;
      continue;
    }
    if (arg.startsWith("-")) continue;
    return arg;
  }
  return null;
}

function shouldBypass(tool: string, args: string[]): boolean {
  const sub = tool === "antigravity"
    ? findAntigravitySubcommand(args)
    : args[0];
  if (tool === "antigravity" && sub !== "chat") return true;
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

  // Inject project memory into AGENTS.md for Codex and OpenCode (both read it at startup)
  if ((tool as string) === "codex" || (tool as string) === "opencode") {
    try { injectCodexContext(cwd, projectId); } catch { /* best-effort */ }
  }
  // Inject project memory into GEMINI.md for Gemini CLI
  if ((tool as string) === "gemini") {
    try { injectGeminiContext(cwd, projectId); } catch { /* best-effort */ }
  }
  if ((tool as string) === "antigravity") {
    try { injectAntigravityContext(cwd, projectId, sessionId); } catch { /* best-effort */ }
  }

  // For Claude: write a temp MCP config and inject --mcp-config so Claude
  // spawns and manages the MCP server itself (proper stdio pipe, not a dead sidecar).
  // For OpenCode: same approach if it supports --mcp-config; skip for Codex/Gemini.
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

  // OpenCode: spawn MCP sidecar the old way (OpenCode's --mcp-config support is unverified)
  const supportsOldSidecar = (tool as string) === "opencode";
  const mcpProc = supportsOldSidecar
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

    // Clean up temp MCP config file written for Claude
    if (mcpConfigPath) {
      try { rmSync(mcpConfigPath); } catch { /* best-effort */ }
    }

    if ((tool as string) !== "antigravity") {
      // existing behavior for all other tools
      try {
        await signalSessionEnd(sessionId, projectId, outcome, code, tool as string, cwd, sessionStartMs);
      } catch (e) {
        console.error("[llm-memory] session end failed:", e);
      }
      mcpProc?.kill();
      process.exit(code ?? 0);
      return;
    }

    // Antigravity: CLI exits fast (~immediately), poll the Electron GUI process
    const pid = findAntigravityElectronPid(cwd);
    if (pid === null) {
      try {
        await signalSessionEnd(sessionId, projectId, outcome, code, tool as string, cwd, sessionStartMs);
      } catch (e) {
        console.error("[llm-memory] session end failed:", e);
      }
      mcpProc?.kill();
      process.exit(0);
      return;
    }

    const MAX_WAIT_MS = 8 * 60 * 60 * 1000; // 8 hours
    const POLL_INTERVAL_MS = 2000;
    const deadline = Date.now() + MAX_WAIT_MS;
    const poll = setInterval(async () => {
      const stillAlive = isProcessAlive(pid);
      const timedOut = Date.now() >= deadline;
      if (!stillAlive || timedOut) {
        clearInterval(poll);
        try {
          await signalSessionEnd(sessionId, projectId, "completed", 0, tool as string, cwd, sessionStartMs);
        } catch (e) {
          console.error("[llm-memory] session end failed:", e);
        }
        mcpProc?.kill();
        process.exit(0);
      }
    }, POLL_INTERVAL_MS);
  });
}

// ─── Entrypoint ───────────────────────────────────────────────────────────────

// Only run when invoked as a wrapper binary (symlink pointing to this file),
// not when imported as a module by the CLI or tests.
// The symlink path (e.g. ~/.llm-memory/bin/claude) never ends with wrapper/index.js,
// but the real tool wrappers always resolve through detectTool() which reads argv[1].
// Safe check: skip main() when argv[1] ends with cli/index.js (npm global bin resolves
// to the real path, but the symlink path at ~/.llm-memory/bin/* does not).
// Simplest reliable check: only run main() when VITEST is unset AND argv[1] does NOT
// resolve to the cli entrypoint.
import { realpathSync as _realpathSync } from "node:fs";
const _realArgv1 = (() => { try { return _realpathSync(process.argv[1] ?? ""); } catch { return process.argv[1] ?? ""; } })();
const _isWrapperEntry = !_realArgv1.endsWith("/cli/index.js") && !_realArgv1.endsWith("/cli/index.ts");

if (!process.env["VITEST"] && _isWrapperEntry) {
  main().catch((e) => {
    console.error("[llm-memory] wrapper fatal error:", e);
    process.exit(1);
  });
}
