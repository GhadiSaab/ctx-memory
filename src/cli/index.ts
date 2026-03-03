#!/usr/bin/env node
// CLI entry point for llm-memory.
// Usage: llm-memory <setup|status|projects <list|show|forget>>

import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { db, getConfigValue, setConfigValue } from "../db/index.js";
import { writeClaudeHooks, writeGeminiHooks, writeOpenCodeHooks } from "../hooks/index.js";
import type { UUID, ToolName } from "../types/index.js";

// ─── Types ────────────────────────────────────────────────────────────────────

const KNOWN_TOOLS: ToolName[] = ["claude-code", "codex", "gemini", "opencode"];

/** Maps ToolName (internal ID) to the actual binary name on disk. */
const TOOL_BINARY: Record<ToolName, string> = {
  "claude-code": "claude",
  "codex": "codex",
  "gemini": "gemini",
  "opencode": "opencode",
};

const PATH_COMMENT = "# llm-memory";
const PATH_LINE = 'export PATH="$HOME/.llm-memory/bin:$PATH"';

export interface ProjectSummary {
  id: string;
  name: string;
  path: string;
  session_count: number;
  last_active_at: number | null;
}

// ─── detectInstalledTools ─────────────────────────────────────────────────────

/**
 * Checks each directory in pathDirs for the known tool executables.
 * Returns only the tool names that exist (no duplicates).
 */
export function detectInstalledTools(pathDirs: string[]): ToolName[] {
  const found = new Set<ToolName>();
  for (const dir of pathDirs) {
    for (const tool of KNOWN_TOOLS) {
      if (found.has(tool)) continue;
      try {
        fs.accessSync(path.join(dir, TOOL_BINARY[tool]), fs.constants.F_OK);
        found.add(tool);
      } catch {
        // not in this dir
      }
    }
  }
  return Array.from(found);
}

// ─── createWrapperSymlink ─────────────────────────────────────────────────────

/**
 * Creates a symlink at <binDir>/<toolName> pointing to wrapperPath.
 * Idempotent: removes existing symlink before creating.
 */
export function createWrapperSymlink(
  toolName: string,
  wrapperPath: string,
  binDir: string
): void {
  const linkPath = path.join(binDir, toolName);
  try {
    fs.lstatSync(linkPath);
    fs.unlinkSync(linkPath);
  } catch {
    // does not exist yet — fine
  }
  fs.symlinkSync(wrapperPath, linkPath);
}

// ─── injectPathLine ───────────────────────────────────────────────────────────

/**
 * Appends the # llm-memory comment + PATH export line to shellRcPath if not already present.
 * Returns true if the line was appended, false if it was already there.
 * Creates the file if it does not exist.
 */
export function injectPathLine(shellRcPath: string): boolean {
  let content = "";
  try {
    content = fs.readFileSync(shellRcPath, "utf8");
  } catch {
    // file doesn't exist yet — will create it
  }
  if (content.includes(PATH_LINE)) {
    return false;
  }
  const prefix = content === "" || content.endsWith("\n") ? "" : "\n";
  const toAppend = `${prefix}${PATH_COMMENT}\n${PATH_LINE}\n`;
  fs.writeFileSync(shellRcPath, content + toAppend, "utf8");
  return true;
}

// ─── registerClaudeMcp ───────────────────────────────────────────────────────

/**
 * Registers the llm-memory MCP server with Claude Code using `claude mcp add`.
 * Idempotent: removes existing entry first (claude mcp add --scope user).
 */
function registerClaudeMcp(receiverPath: string): void {
  const mcpScript = path.resolve(path.dirname(receiverPath), "../mcp/index.js");
  try {
    // Remove existing registration (ignore errors if not registered yet)
    execSync(`claude mcp remove llm-memory --scope user 2>/dev/null || true`, { stdio: "pipe" });
    execSync(
      `claude mcp add --scope user llm-memory -- node ${mcpScript}`,
      { stdio: "pipe" }
    );
  } catch {
    // Non-fatal: user can register manually
    console.warn("  Warning: could not auto-register MCP server. Run manually:");
    console.warn(`    claude mcp add --scope user llm-memory -- node ${mcpScript}`);
  }
}

// ─── forgetProject ────────────────────────────────────────────────────────────

/**
 * Soft (hard=false): reset memory_doc to NULL, delete known_issues + recent_work.
 * Hard (hard=true): additionally delete events, digests, messages_raw, sessions.
 * The project row itself is always preserved.
 */
export function forgetProject(projectId: UUID, hard: boolean): void {
  if (hard) {
    // Delete child rows in FK dependency order before removing sessions.
    db.prepare(
      "DELETE FROM events WHERE session_id IN (SELECT id FROM sessions WHERE project_id = ?)"
    ).run(projectId);
    db.prepare(
      "DELETE FROM digests WHERE session_id IN (SELECT id FROM sessions WHERE project_id = ?)"
    ).run(projectId);
    db.prepare(
      "DELETE FROM messages_raw WHERE session_id IN (SELECT id FROM sessions WHERE project_id = ?)"
    ).run(projectId);
    // recent_work and known_issues also reference sessions
    db.prepare("DELETE FROM recent_work WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM known_issues WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM sessions WHERE project_id = ?").run(projectId);
  }

  db.prepare("UPDATE projects SET memory_doc = NULL WHERE id = ?").run(projectId);
  if (!hard) {
    db.prepare("DELETE FROM known_issues WHERE project_id = ?").run(projectId);
    db.prepare("DELETE FROM recent_work WHERE project_id = ?").run(projectId);
  }
}

// ─── getAllProjects ───────────────────────────────────────────────────────────

/**
 * Returns all projects with session count and last active timestamp.
 */
export function getAllProjects(): ProjectSummary[] {
  const rows = db.prepare<[], {
    id: string;
    name: string;
    path: string;
    session_count: number;
    last_active_at: number | null;
  }>(`
    SELECT
      p.id,
      p.name,
      p.path,
      COUNT(s.id) AS session_count,
      MAX(s.started_at) AS last_active_at
    FROM projects p
    LEFT JOIN sessions s ON s.project_id = p.id
    GROUP BY p.id
    ORDER BY p.created_at DESC
  `).all();
  return rows;
}

// ─── getProjectByName ────────────────────────────────────────────────────────

/**
 * Finds a project by exact name match. Returns null if not found.
 */
export function getProjectByName(name: string): ProjectSummary | null {
  const row = db.prepare<[string], {
    id: string;
    name: string;
    path: string;
    session_count: number;
    last_active_at: number | null;
  }>(`
    SELECT
      p.id,
      p.name,
      p.path,
      COUNT(s.id) AS session_count,
      MAX(s.started_at) AS last_active_at
    FROM projects p
    LEFT JOIN sessions s ON s.project_id = p.id
    WHERE p.name = ?
    GROUP BY p.id
  `).get(name);
  return row ?? null;
}

// ─── CLI entry point ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === "help" || cmd === "--help") {
    printHelp();
    return;
  }

  if (cmd === "setup") {
    await runSetup();
    return;
  }

  if (cmd === "status") {
    runStatus();
    return;
  }

  if (cmd === "projects") {
    const sub = args[1];
    if (sub === "list") {
      runProjectsList();
    } else if (sub === "show") {
      runProjectsShow(args[2]);
    } else if (sub === "forget") {
      runProjectsForget(args[2], args.includes("--hard"));
    } else {
      console.error(`Unknown projects subcommand: ${sub ?? "(none)"}`);
      console.error('Usage: llm-memory projects <list|show <name>|forget <name> [--hard]>');
      process.exit(1);
    }
    return;
  }

  console.error(`Unknown command: ${cmd}`);
  printHelp();
  process.exit(1);
}

function printHelp(): void {
  console.log(`llm-memory — persistent memory for LLM coding agents

Commands:
  setup                          Interactive setup wizard
  status                         Show current configuration and stats
  projects list                  List all projects
  projects show <name>           Show project memory doc
  projects forget <name>         Reset project memory (soft)
  projects forget <name> --hard  Delete all sessions + data for project
`);
}

// ─── setup ───────────────────────────────────────────────────────────────────

async function runSetup(): Promise<void> {
  const { checkbox, confirm } = await import("@inquirer/prompts");

  const pathDirs = (process.env["PATH"] ?? "").split(":");
  const detected = detectInstalledTools(pathDirs);

  if (detected.length === 0) {
    console.log("No supported tools found in PATH (claude, codex, gemini, opencode).");
    console.log("Install a tool first, then run llm-memory setup again.");
    return;
  }

  const selected = await checkbox({
    message: "Which tools do you want llm-memory to integrate with?",
    choices: detected.map((t) => ({ name: t, value: t, checked: true })),
  }) as ToolName[];

  if (selected.length === 0) {
    console.log("No tools selected. Nothing to do.");
    return;
  }

  const storeRaw = await confirm({
    message: "Store raw messages? (uses more space, off by default)",
    default: false,
  });

  // Ensure ~/.llm-memory/bin exists
  const llmBin = path.join(homedir(), ".llm-memory", "bin");
  fs.mkdirSync(llmBin, { recursive: true });

  // Resolve paths relative to this script's install location
  const scriptDir = path.dirname(new URL(import.meta.url).pathname);
  const wrapperPath = path.resolve(scriptDir, "../wrapper/index.js");
  const receiverPath = path.resolve(scriptDir, "../hooks/receiver.js");

  // Always create hook-receiver symlink (needed by all tool hooks)
  createWrapperSymlink("hook-receiver", receiverPath, llmBin);

  const results: string[] = [];

  for (const tool of selected) {
    // Write hook configs + register MCP server
    if (tool === "claude-code") {
      writeClaudeHooks(path.join(homedir(), ".claude"));
      registerClaudeMcp(receiverPath);
    } else if (tool === "gemini") {
      writeGeminiHooks(path.join(homedir(), ".gemini"));
    } else if (tool === "opencode") {
      writeOpenCodeHooks(path.join(homedir(), ".opencode"));
    }
    // Create wrapper symlink named after the binary (e.g. "claude", not "claude-code")
    createWrapperSymlink(TOOL_BINARY[tool], wrapperPath, llmBin);
    results.push(tool);
  }

  // Inject PATH into shell rc files
  const home = homedir();
  const injected: string[] = [];
  for (const rc of [".bashrc", ".zshrc"]) {
    const rcPath = path.join(home, rc);
    if (injectPathLine(rcPath)) {
      injected.push(rc);
    }
  }

  // Persist config
  setConfigValue("store_raw_messages", storeRaw);

  // Summary
  console.log("\n✓ llm-memory setup complete!\n");
  console.log(`  Tools configured: ${results.join(", ")}`);
  if (injected.length > 0) {
    console.log(`  PATH updated in: ${injected.map((r) => `~/${r}`).join(", ")}`);
    console.log('  Run: source ~/.bashrc   (or restart your shell)');
  }
  console.log(`  Raw messages: ${storeRaw ? "on" : "off"}`);
}

// ─── status ───────────────────────────────────────────────────────────────────

function runStatus(): void {
  const dbPath = process.env["LLM_MEMORY_DB_PATH"] ?? path.join(homedir(), ".llm-memory", "store.db");

  // DB size
  let dbSize = "not found";
  try {
    const stat = fs.statSync(dbPath);
    dbSize = formatBytes(stat.size);
  } catch {
    // DB doesn't exist yet
  }

  // Tool detection
  const pathDirs = (process.env["PATH"] ?? "").split(":");
  const installed = detectInstalledTools(pathDirs);
  const toolLine = KNOWN_TOOLS.map((t) =>
    `${t} ${installed.includes(t) ? "✓" : "✗"}`
  ).join("  ");

  // Session stats
  const totalSessions = (db.prepare<[], { count: number }>(
    "SELECT COUNT(*) AS count FROM sessions"
  ).get())?.count ?? 0;

  // Last session
  const lastSession = db.prepare<[], {
    goal: string | null;
    started_at: number;
    outcome: string | null;
  }>("SELECT goal, started_at, outcome FROM sessions ORDER BY started_at DESC LIMIT 1").get();

  const { version } = JSON.parse(
    fs.readFileSync(
      path.join(path.dirname(new URL(import.meta.url).pathname), "../../../package.json"),
      "utf8"
    )
  ) as { version: string };

  console.log(`llm-memory v${version}`);
  console.log(`DB: ${dbPath.replace(homedir(), "~")} (${dbSize})`);
  console.log(`Tools: ${toolLine}`);
  console.log(`Sessions: ${totalSessions} total`);
  if (lastSession) {
    const date = new Date(lastSession.started_at).toISOString().slice(0, 10);
    const goal = lastSession.goal ?? "(no goal)";
    const outcome = lastSession.outcome ?? "in progress";
    console.log(`Last session: ${goal} (${date}, ${outcome})`);
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ─── projects list ────────────────────────────────────────────────────────────

function runProjectsList(): void {
  const projects = getAllProjects();
  if (projects.length === 0) {
    console.log("No projects found.");
    return;
  }
  console.log(`${"Name".padEnd(24)} ${"Sessions".padEnd(10)} ${"Last active".padEnd(12)} Path`);
  console.log("─".repeat(80));
  for (const p of projects) {
    const date = p.last_active_at
      ? new Date(p.last_active_at).toISOString().slice(0, 10)
      : "never";
    console.log(
      `${p.name.padEnd(24)} ${String(p.session_count).padEnd(10)} ${date.padEnd(12)} ${p.path}`
    );
  }
}

// ─── projects show ────────────────────────────────────────────────────────────

function runProjectsShow(name: string | undefined): void {
  if (!name) {
    console.error("Usage: llm-memory projects show <name>");
    process.exit(1);
  }
  const project = getProjectByName(name);
  if (!project) {
    console.error(`Project not found: ${name}`);
    process.exit(1);
  }
  const row = db.prepare<[string], { memory_doc: string | null }>(
    "SELECT memory_doc FROM projects WHERE id = ?"
  ).get(project.id);
  if (!row?.memory_doc) {
    console.log(`No memory doc for project: ${name}`);
    return;
  }
  console.log(row.memory_doc);
}

// ─── projects forget ──────────────────────────────────────────────────────────

function runProjectsForget(name: string | undefined, hard: boolean): void {
  if (!name) {
    console.error("Usage: llm-memory projects forget <name> [--hard]");
    process.exit(1);
  }
  const project = getProjectByName(name);
  if (!project) {
    console.error(`Project not found: ${name}`);
    process.exit(1);
  }
  forgetProject(project.id as UUID, hard);
  if (hard) {
    console.log(`✓ Hard-forgot project: ${name} (all sessions, digests, events deleted)`);
  } else {
    console.log(`✓ Forgot project: ${name} (memory reset, sessions preserved)`);
  }
}

// ─── Run ─────────────────────────────────────────────────────────────────────

// Only run when executed directly, not when imported as a module in tests.
// Vitest sets VITEST env var; we're also safe to check argv[1] for the test runner.
const isVitest = !!process.env["VITEST"];

if (!isVitest) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
