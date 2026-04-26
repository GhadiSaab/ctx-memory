// Claude Code session reader — extracts messages and tool events from Claude's
// local JSONL session files as a fallback when hooks failed to capture events.
//
// Claude stores sessions in:
//   ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
//
// Encoding: absolute path with '/' replaced by '-' (e.g. /home/user/proj → -home-user-proj)
//
// We read the file only when the DB has 0 events for the session (hooks failed).

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type { Message, UUID, UnixMs } from "../types/index.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RawClaudeEvent {
  tool: string;
  args: Record<string, unknown>;
  result: Record<string, unknown>;
  success: boolean;
}

export interface ClaudeSessionData {
  messages: Message[];
  events: RawClaudeEvent[];
}

interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | Array<{ type: string; text?: string }>;
}

// ─── Path helpers ─────────────────────────────────────────────────────────────

function encodeCwd(cwd: string): string {
  // /home/user/proj → -home-user-proj
  return cwd.replace(/\//g, "-");
}

export function resolveProjectDir(cwd: string): string {
  const encoded = encodeCwd(cwd);
  return join(homedir(), ".claude", "projects", encoded);
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Find and read the Claude session file for the given cwd that was created
 * at or after sessionStartMs. Claude names its files by its own internal
 * session UUID (not our CTX_MEMORY_SESSION_ID), so we match by directory + mtime.
 */
export function readClaudeSession(
  cwd: string,
  sessionId: string,
  sessionStartMs: number
): ClaudeSessionData | null {
  const projectDir = resolveProjectDir(cwd);
  if (!existsSync(projectDir)) return null;

  // Find the most recently modified .jsonl file created after sessionStartMs
  let bestFile: string | null = null;
  let bestMtime = 0;

  try {
    for (const name of readdirSync(projectDir)) {
      if (!name.endsWith(".jsonl")) continue;
      const filePath = join(projectDir, name);
      try {
        const { mtimeMs } = statSync(filePath);
        if (mtimeMs >= sessionStartMs && mtimeMs > bestMtime) {
          bestMtime = mtimeMs;
          bestFile = filePath;
        }
      } catch { /* skip */ }
    }
  } catch {
    return null;
  }

  if (!bestFile) return null;

  let raw: string;
  try {
    raw = readFileSync(bestFile, "utf8");
  } catch {
    return null;
  }

  return parseSessionFile(raw, sessionId);
}

// ─── Parser ───────────────────────────────────────────────────────────────────

function parseSessionFile(raw: string, sessionId: string): ClaudeSessionData {
  const messages: Message[] = [];
  const events: RawClaudeEvent[] = [];

  const fakeSessionId = sessionId as UUID;
  const now = Date.now() as UnixMs;

  // Collect tool_use blocks from assistant messages, keyed by tool use id
  const toolUseMap = new Map<string, ToolUseBlock>();

  let messageIndex = 0;

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }

    const type = obj["type"] as string | undefined;

    // ── Assistant messages — extract text + tool_use blocks ──────────────────
    if (type === "assistant") {
      const msg = obj["message"] as Record<string, unknown> | undefined;
      if (!msg) continue;

      const content = msg["content"];
      if (!Array.isArray(content)) continue;

      let textParts: string[] = [];

      for (const block of content as Record<string, unknown>[]) {
        const blockType = block["type"] as string | undefined;

        if (blockType === "text") {
          const text = (block["text"] as string | undefined) ?? "";
          if (text.trim()) textParts.push(text.trim());
        }

        if (blockType === "tool_use") {
          const id = (block["id"] as string | undefined) ?? "";
          const name = (block["name"] as string | undefined) ?? "";
          const input = (block["input"] as Record<string, unknown> | undefined) ?? {};
          if (id && name) toolUseMap.set(id, { type: "tool_use", id, name, input });
        }
      }

      if (textParts.length > 0) {
        const ts = parseTimestamp(obj["timestamp"] as string | undefined, now);
        messages.push({
          id: randomUUID() as UUID,
          session_id: fakeSessionId,
          role: "assistant",
          content: textParts.join("\n"),
          index: messageIndex++,
          timestamp: ts,
        });
      }
    }

    // ── User messages — extract text + tool_result blocks ───────────────────
    if (type === "user") {
      const msg = obj["message"] as Record<string, unknown> | undefined;
      if (!msg) continue;

      const content = msg["content"];
      const ts = parseTimestamp(obj["timestamp"] as string | undefined, now);

      // Plain string content — direct user message
      if (typeof content === "string") {
        const text = content.trim();
        // Skip Claude's internal command messages
        if (text && !isInternalMessage(text)) {
          messages.push({
            id: randomUUID() as UUID,
            session_id: fakeSessionId,
            role: "user",
            content: text,
            index: messageIndex++,
            timestamp: ts,
          });
        }
        continue;
      }

      if (!Array.isArray(content)) continue;

      // Array content — may contain tool_result blocks and/or text
      let userText: string[] = [];

      for (const block of content as Record<string, unknown>[]) {
        const blockType = block["type"] as string | undefined;

        // Plain text block in user message
        if (blockType === "text") {
          const text = (block["text"] as string | undefined) ?? "";
          if (text.trim()) userText.push(text.trim());
        }

        // Tool result — pair with the tool_use we stored earlier
        if (blockType === "tool_result") {
          const toolUseId = (block["tool_use_id"] as string | undefined) ?? "";
          const toolUse = toolUseMap.get(toolUseId);
          if (!toolUse) continue;

          // Extract result text
          const resultContent = block["content"];
          let resultText = "";
          if (typeof resultContent === "string") {
            resultText = resultContent;
          } else if (Array.isArray(resultContent)) {
            resultText = (resultContent as Record<string, unknown>[])
              .filter(c => c["type"] === "text")
              .map(c => (c["text"] as string | undefined) ?? "")
              .join("\n");
          }

          const success = !resultText.toLowerCase().startsWith("error");

          events.push({
            tool: toolUse.name,
            args: toolUse.input,
            result: { output: resultText.slice(0, 500) },
            success,
          });
        }
      }

      if (userText.length > 0) {
        messages.push({
          id: randomUUID() as UUID,
          session_id: fakeSessionId,
          role: "user",
          content: userText.join("\n"),
          index: messageIndex++,
          timestamp: ts,
        });
      }
    }
  }

  return { messages, events };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseTimestamp(ts: string | undefined, fallback: UnixMs): UnixMs {
  if (!ts) return fallback;
  const ms = Date.parse(ts);
  return (isNaN(ms) ? fallback : ms) as UnixMs;
}

function isInternalMessage(text: string): boolean {
  return (
    text.startsWith("<local-command-caveat>") ||
    text.startsWith("<local-command-stdout>") ||
    text.startsWith("<local-command-stderr>") ||
    text.startsWith("<command-name>") ||
    text.startsWith("<command-message>")
  );
}
