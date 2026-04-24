// Gemini CLI session reader — extracts messages and tool events from Gemini's
// local JSONL session files after a session ends.
//
// Gemini stores sessions in:
//   ~/.gemini/projects.json      — maps cwd → project name
//   ~/.gemini/tmp/<name>/chats/session-*.jsonl  — per-session JSONL
//
// Each JSONL file has one JSON object per line:
//   Line 1: {"sessionId":..., "startTime":..., "kind":"main"}  (header)
//   Subsequent lines: message objects or $set delta patches
//
// Message objects:
//   {"type":"user",   "content":[{"text":"..."}]}
//   {"type":"gemini", "content":"...", "toolCalls":[...]}
//   {"$set":{...}}  — ignored (metadata patches)

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type { Message, UUID, UnixMs } from "../types/index.js";

// ─── Types ────────────────────────────────────────────────────────────────────

interface GeminiSessionHeader {
  sessionId: string;
  startTime: string;
  kind: "main";
}

interface GeminiToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result?: unknown;
  status?: "success" | "error";
}

interface GeminiMessageLine {
  id?: string;
  type?: "user" | "gemini";
  timestamp?: string;
  content?: string | Array<{ text?: string }>;
  toolCalls?: GeminiToolCall[];
  $set?: Record<string, unknown>;
}

export interface RawGeminiEvent {
  tool: string;
  args: Record<string, unknown>;
  result: Record<string, unknown>;
  success: boolean;
}

export interface GeminiSessionData {
  messages: Message[];
  events: RawGeminiEvent[];
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Reads Gemini session data for the given project cwd, filtered to sessions
 * that started at or after sessionStartMs.
 *
 * Returns null if no Gemini history exists or no matching session found.
 */
export function readGeminiSession(
  cwd: string,
  sessionStartMs: number
): GeminiSessionData | null {
  const projectName = resolveGeminiProjectName(cwd);
  if (!projectName) return null;

  const chatsDir = join(homedir(), ".gemini", "tmp", projectName, "chats");
  if (!existsSync(chatsDir)) return null;

  const sessionFile = findLatestSessionFile(chatsDir, sessionStartMs);
  if (!sessionFile) return null;

  return parseGeminiSessionFile(sessionFile);
}

// ─── Project name resolution ──────────────────────────────────────────────────

function resolveGeminiProjectName(cwd: string): string | null {
  const projectsPath = join(homedir(), ".gemini", "projects.json");
  if (!existsSync(projectsPath)) return null;

  try {
    const data = JSON.parse(readFileSync(projectsPath, "utf8")) as {
      projects?: Record<string, string>;
    };
    return data.projects?.[cwd] ?? null;
  } catch {
    return null;
  }
}

// ─── Session file finder ──────────────────────────────────────────────────────

function findLatestSessionFile(chatsDir: string, sessionStartMs: number): string | null {
  let entries: string[];
  try {
    entries = readdirSync(chatsDir);
  } catch {
    return null;
  }

  // session-YYYY-MM-DDTHH-MM-<uuid>.jsonl
  const jsonlFiles = entries
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => ({ name: f, path: join(chatsDir, f) }))
    .filter(({ path }) => {
      try {
        return statSync(path).mtimeMs >= sessionStartMs - 5000; // 5s tolerance
      } catch {
        return false;
      }
    })
    .sort((a, b) => {
      try {
        return statSync(b.path).mtimeMs - statSync(a.path).mtimeMs;
      } catch {
        return 0;
      }
    });

  return jsonlFiles[0]?.path ?? null;
}

// ─── JSONL parser ─────────────────────────────────────────────────────────────

function parseGeminiSessionFile(filePath: string): GeminiSessionData {
  const messages: Message[] = [];
  const events: RawGeminiEvent[] = [];

  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return { messages, events };
  }

  const fakeSessionId = randomUUID() as UUID;
  const now = Date.now() as UnixMs;
  let messageIndex = 0;
  let isFirstLine = true;

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let obj: GeminiMessageLine;
    try {
      obj = JSON.parse(trimmed) as GeminiMessageLine;
    } catch {
      continue;
    }

    // Skip header line and $set delta patches
    if (isFirstLine) {
      isFirstLine = false;
      const header = obj as unknown as GeminiSessionHeader;
      if (header.kind === "main") continue;
    }
    if (obj.$set !== undefined) continue;

    // User messages
    if (obj.type === "user") {
      const text = extractUserText(obj.content);
      if (text) {
        messages.push({
          id: randomUUID() as UUID,
          session_id: fakeSessionId,
          role: "user",
          content: text,
          index: messageIndex++,
          timestamp: now,
        });
      }
      continue;
    }

    // Gemini (assistant) messages — may contain tool calls
    if (obj.type === "gemini") {
      // Extract tool calls first
      if (Array.isArray(obj.toolCalls)) {
        for (const tc of obj.toolCalls) {
          const event = geminiToolCallToEvent(tc);
          if (event) events.push(event);
        }
      }

      // Only capture non-empty text responses (not pure tool-call turns)
      const text = typeof obj.content === "string" ? obj.content.trim() : "";
      if (text) {
        messages.push({
          id: randomUUID() as UUID,
          session_id: fakeSessionId,
          role: "assistant",
          content: text,
          index: messageIndex++,
          timestamp: now,
        });
      }
    }
  }

  return { messages, events };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractUserText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return (content as Array<{ text?: string }>)
      .map((c) => c.text ?? "")
      .join("")
      .trim();
  }
  return "";
}

function geminiToolCallToEvent(tc: GeminiToolCall): RawGeminiEvent | null {
  if (!tc.name) return null;

  const args = tc.args ?? {};
  const success = tc.status !== "error";

  let result: Record<string, unknown> = {};
  if (tc.result !== undefined) {
    result = typeof tc.result === "object" && tc.result !== null
      ? (tc.result as Record<string, unknown>)
      : { output: String(tc.result) };
  }

  return {
    tool: classifyGeminiTool(tc.name),
    args,
    result: { ...result, success },
    success,
  };
}

function classifyGeminiTool(name: string): string {
  switch (name) {
    case "write_file":
    case "create_file":
      return "write";
    case "read_file":
      return "read";
    case "edit_file":
    case "replace_in_file":
      return "edit";
    case "run_shell_command":
    case "exec_command":
    case "bash":
      return "bash";
    case "glob":
    case "grep_search":
    case "find_files":
      return "read";
    default:
      return name;
  }
}
