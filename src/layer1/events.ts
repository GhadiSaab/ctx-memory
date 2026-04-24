// Tool event classifier — pure function, no I/O, never throws.
// Converts raw MCP tool calls into typed ExtractedEvent payloads.

import type { ExtractedEvent, EventPayload } from "../types/index.js";
import { randomUUID } from "node:crypto";

// ─── Detection helpers ────────────────────────────────────────────────────────

export function isInstallCommand(cmd: string): boolean {
  return /\b(npm\s+install|npm\s+i|yarn\s+add|pnpm\s+add|pip\s+install|pip3\s+install|cargo\s+add|gem\s+install|go\s+get)\b/.test(cmd);
}

export function isTestCommand(cmd: string): boolean {
  return /\b(jest|vitest|pytest|mocha|jasmine|karma|cargo\s+test|go\s+test|npm\s+(run\s+)?test|yarn\s+test|pnpm\s+test|phpunit|rspec|dotnet\s+test)\b/.test(cmd);
}

export function isBuildCommand(cmd: string): boolean {
  return /\b(docker\s+build|npm\s+run\s+build|yarn\s+build|pnpm\s+build|cargo\s+build|go\s+build|make\b|gradle\s+build|mvn\s+(package|install|compile)|tsc\b|webpack\b|vite\s+build|next\s+build)\b/.test(cmd);
}

export function isConfigFile(path: string): boolean {
  return /(\.(env|env\.\w+)|docker-compose\.ya?ml|dockerfile|tsconfig.*\.json|\.eslintrc.*|\.prettierrc.*|babel\.config\.\w+|vite\.config\.\w+|webpack\.config\.\w+|jest\.config\.\w+|vitest\.config\.\w+|package\.json|pyproject\.toml|cargo\.toml|go\.mod)$/i.test(path);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function num(v: unknown): number {
  return typeof v === "number" ? v : 0;
}

function makeEvent(
  payload: EventPayload,
  weight: number
): ExtractedEvent {
  return {
    id: randomUUID() as any,
    session_id: "" as any,   // caller fills this in after classification
    type: payload.type,
    payload,
    weight,
    timestamp: Date.now() as any,
    source: "mcp",
  };
}

// ─── File tool handlers ───────────────────────────────────────────────────────

function handleFileTool(
  tool: string,
  args: Record<string, unknown>
): ExtractedEvent | null {
  const path = str(args["path"] ?? args["file_path"] ?? args["filepath"] ?? args["filePath"] ?? "");
  if (!path) return null;

  if (isConfigFile(path)) {
    return makeEvent(
      { type: "config_modified", path, key: null },
      0.7
    );
  }

  const isCreate = tool === "write" || tool === "write_file" || tool === "create_file";
  const fileType = isCreate ? "file_created" : "file_modified";

  return makeEvent(
    {
      type: fileType,
      path,
      operation: tool,
      diffSummary: str(args["diff"] ?? args["old_str"] ?? null) || null,
    },
    0.8
  );
}

// ─── Bash/command handler ─────────────────────────────────────────────────────

function handleBashTool(
  args: Record<string, unknown>,
  result: Record<string, unknown>,
  success: boolean
): ExtractedEvent | null {
  const command = str(args["command"] ?? args["cmd"] ?? "");
  const exitCode = num(result["exit_code"] ?? result["exitCode"] ?? (success ? 0 : 1));
  const output = str(result["output"] ?? result["stdout"] ?? "");

  // git commit
  if (/\bgit\s+commit\b/.test(command)) {
    const msgMatch = command.match(/-m\s+['"]([^'"]+)['"]/);
    const hashMatch = output.match(/\b([0-9a-f]{7,40})\b/);
    return makeEvent(
      {
        type: "commit",
        message: msgMatch ? msgMatch[1] : command,
        hash: hashMatch ? hashMatch[1] : null,
      },
      0.9
    );
  }

  // dependency install
  if (isInstallCommand(command)) {
    const parts = command.trim().split(/\s+/);
    // extract package name: last non-flag token after install/add/get
    const pkgIdx = parts.findIndex((p) => /^(install|i|add|get)$/.test(p));
    const pkg = pkgIdx !== -1
      ? (parts.slice(pkgIdx + 1).find((p) => !p.startsWith("-")) ?? "")
      : "";
    const manager = parts[0] ?? "unknown";
    return makeEvent(
      {
        type: "dependency_added",
        manager,
        package: pkg,
        version: null,
      },
      0.6
    );
  }

  // test run
  if (isTestCommand(command)) {
    const passedMatch = output.match(/(\d+)\s+(passed|tests?\s+passed)/i);
    const failedMatch = output.match(/(\d+)\s+(failed|tests?\s+failed)/i);
    return makeEvent(
      {
        type: "test_run",
        command,
        passed: passedMatch ? parseInt(passedMatch[1], 10) : (success ? 1 : 0),
        failed: failedMatch ? parseInt(failedMatch[1], 10) : (success ? 0 : 1),
        durationMs: null,
      },
      0.7
    );
  }

  // build
  if (isBuildCommand(command)) {
    const errorSummary = !success
      ? str(result["stderr"] ?? result["error"] ?? "").slice(0, 200) || null
      : null;
    return makeEvent(
      {
        type: "build_attempt",
        command,
        success,
        durationMs: null,
        errorSummary,
      },
      0.6
    );
  }

  // failed command → error
  if (!success) {
    const errMsg = str(result["stderr"] ?? result["error"] ?? result["output"] ?? "error");
    return makeEvent(
      {
        type: "error",
        message: errMsg.slice(0, 300) || command,
        command,
        exitCode,
      },
      0.7
    );
  }

  // generic successful command
  return makeEvent(
    {
      type: "command_run",
      command,
      exitCode,
      success,
    },
    0.3
  );
}

// ─── Main export ──────────────────────────────────────────────────────────────

export function classifyToolEvent(
  tool: string,
  args: Record<string, unknown>,
  result: Record<string, unknown>,
  success: boolean
): ExtractedEvent | null {
  const t = tool.toLowerCase();

  // Claude Code tool names (Write, Edit, Bash) + generic snake_case variants
  if (t === "write" || t === "write_file" || t === "create_file") {
    return handleFileTool(t, args);
  }

  if (t === "edit" || t === "edit_file" || t === "str_replace" || t === "str_replace_editor") {
    return handleFileTool(t, args);
  }

  if (t === "bash" || t === "run_command" || t === "execute_command") {
    return handleBashTool(args, result, success);
  }

  // Unknown tool — not worth storing
  return null;
}
