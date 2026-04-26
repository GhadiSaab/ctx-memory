#!/usr/bin/env node
// Hook receiver — called by every tool hook (Claude Code, Gemini, OpenCode).
// Reads JSON from stdin, classifies the tool event, inserts into DB.
// Must exit in <500ms. DB write is synchronous — safe.

import { classifyToolEvent } from "../layer1/events.js";
import { insertEvent, getSessionById, createSession, getProjectByPathHash, createProject } from "../db/index.js";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import type { UUID } from "../types/index.js";

// ─── processHookPayload ───────────────────────────────────────────────────────
// Pure-ish core: classify + insert. Returns true if event stored, false otherwise.
// Never throws.

export function processHookPayload(
  sessionId: string,
  payload: Record<string, unknown>
): boolean {
  try {
    // Normalise across Claude Code ({ tool_name, tool_input, tool_response })
    // and Gemini/OpenCode ({ tool, args, result }) shapes.
    const toolName = str(payload["tool_name"] ?? payload["tool"]);
    const args = obj(payload["tool_input"] ?? payload["args"]);
    const result = obj(payload["tool_response"] ?? payload["result"]);
    const success = resolveSuccess(result);

    if (!toolName) return false;

    const event = classifyToolEvent(toolName, args, result, success);
    if (!event) return false;

    // Ensure session exists in DB — create it on the fly if missing (hook fired
    // without the wrapper, e.g. claude launched directly not via ctx-memory shim)
    if (!getSessionById(sessionId as UUID)) {
      const cwd = str(payload["cwd"] ?? process.cwd());
      const pathHash = createHash("sha256").update(cwd).digest("hex");
      const project = getProjectByPathHash(pathHash) ?? createProject({
        name: basename(cwd),
        path: cwd,
        git_remote: null,
        path_hash: pathHash,
      });
      createSession({
        id: sessionId as UUID,
        project_id: project.id,
        tool: "claude-code",
      });
    }

    insertEvent({
      session_id: sessionId as UUID,
      type: event.type,
      payload: event.payload,
      weight: event.weight,
      source: "hook",
    });

    return true;
  } catch {
    return false;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function obj(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function resolveSuccess(result: Record<string, unknown>): boolean {
  if (typeof result["success"] === "boolean") return result["success"];
  if (typeof result["exitCode"] === "number") return result["exitCode"] === 0;
  if (typeof result["exit_code"] === "number") return result["exit_code"] === 0;
  return true; // assume success when not specified
}

// ─── readStdin ────────────────────────────────────────────────────────────────

export async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => resolve(data));
    // If stdin closes immediately (no data), resolve with empty string
    process.stdin.on("error", () => resolve(""));
  });
}

// ─── parseArgs ────────────────────────────────────────────────────────────────

export function parseArgs(argv: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      result[arg] = argv[i + 1] ?? "";
      i++;
    }
  }
  return result;
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  let stdin = "";
  try {
    stdin = await readStdin();
  } catch {
    process.exit(0);
  }

  if (!stdin.trim()) process.exit(0);

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(stdin);
  } catch {
    // Malformed JSON → silent exit, never crash the tool
    process.exit(0);
  }

  // Resolve session ID: --session arg takes priority, then payload.session_id (Claude Code native)
  const sessionId = args["--session"] || (typeof payload["session_id"] === "string" ? payload["session_id"] : "");

  if (!sessionId) process.exit(0);

  processHookPayload(sessionId, payload);
  process.exit(0);
}

// Only run main when executed directly (not imported in tests)
if (!process.env["VITEST"]) {
  main().catch(() => process.exit(0));
}
