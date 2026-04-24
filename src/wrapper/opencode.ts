// OpenCode session reader — extracts messages and tool events from OpenCode's
// local SQLite store after a session ends.
//
// OpenCode stores sessions in:
//   ~/.local/share/opencode/opencode.db
//
// We match sessions by cwd + start timestamp, then parse message/part rows.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import DatabaseConstructor from "better-sqlite3";
import type { Message, UUID, UnixMs } from "../types/index.js";

interface OpenCodeSessionRow {
  id: string;
}

interface OpenCodePartRow {
  message_id: string;
  message_data: string;
  part_id: string;
  part_data: string;
  time_created: number;
}

export interface RawOpenCodeEvent {
  tool: string;
  args: Record<string, unknown>;
  result: Record<string, unknown>;
  success: boolean;
}

export interface OpenCodeSessionData {
  messages: Message[];
  events: RawOpenCodeEvent[];
}

export function readOpenCodeSession(
  cwd: string,
  sessionStartMs: number
): OpenCodeSessionData | null {
  const dbPath = join(homedir(), ".local", "share", "opencode", "opencode.db");
  if (!existsSync(dbPath)) return null;

  let openCodeDb: ReturnType<typeof DatabaseConstructor> | null = null;
  try {
    openCodeDb = new DatabaseConstructor(dbPath, { readonly: true, fileMustExist: true });

    const sessionStart = sessionStartMs - 5000;
    const session = openCodeDb
      .prepare<[string, number], OpenCodeSessionRow>(
        `SELECT id
         FROM session
         WHERE directory = ? AND time_created >= ?
         ORDER BY time_created DESC
         LIMIT 1`
      )
      .get(cwd, sessionStart);

    if (!session) return null;

    const rows = openCodeDb
      .prepare<[string], OpenCodePartRow>(
        `SELECT
           m.id AS message_id,
           m.data AS message_data,
           p.id AS part_id,
           p.data AS part_data,
           p.time_created AS time_created
         FROM message m
         LEFT JOIN part p ON p.message_id = m.id
         WHERE m.session_id = ?
         ORDER BY m.time_created ASC, p.time_created ASC, p.id ASC`
      )
      .all(session.id);

    return parseOpenCodeRows(rows, session.id);
  } catch {
    return null;
  } finally {
    openCodeDb?.close();
  }
}

export function parseOpenCodeRows(
  rows: OpenCodePartRow[],
  openCodeSessionId: string
): OpenCodeSessionData {
  const messages: Message[] = [];
  const events: RawOpenCodeEvent[] = [];
  const fakeSessionId = openCodeSessionId as UUID;

  const messageText = new Map<string, {
    role: "user" | "assistant";
    timestamp: UnixMs;
    parts: string[];
  }>();

  for (const row of rows) {
    const messageData = parseObject(row.message_data);
    const role = messageData["role"];
    const normalizedRole = role === "user" || role === "assistant" ? role : null;
    if (!normalizedRole) continue;

    const partData = parseObject(row.part_data);
    const partType = partData["type"];

    if (partType === "text") {
      const text = cleanText(str(partData["text"]), normalizedRole);
      if (!text) continue;

      const entry = messageText.get(row.message_id) ?? {
        role: normalizedRole,
        timestamp: row.time_created as UnixMs,
        parts: [],
      };
      entry.parts.push(text);
      messageText.set(row.message_id, entry);
      continue;
    }

    if (partType === "tool") {
      const tool = str(partData["tool"]);
      const state = obj(partData["state"]);
      const input = obj(state["input"]);
      const output = state["output"];
      const metadata = obj(state["metadata"]);
      const status = str(state["status"]);

      if (!tool) continue;

      events.push({
        tool: classifyOpenCodeTool(tool),
        args: input,
        result: {
          output: typeof output === "string" ? output.slice(0, 500) : "",
          success: status ? status === "completed" : true,
          filepath: metadata["filepath"] ?? input["filePath"] ?? input["file_path"] ?? input["path"] ?? null,
        },
        success: status ? status === "completed" : true,
      });
    }
  }

  let index = 0;
  for (const entry of messageText.values()) {
    const content = entry.parts.join("\n").trim();
    if (!content) continue;

    messages.push({
      id: randomUUID() as UUID,
      session_id: fakeSessionId,
      role: entry.role,
      content,
      index: index++,
      timestamp: entry.timestamp,
    });
  }

  return { messages, events };
}

function parseObject(raw: string): Record<string, unknown> {
  try {
    return obj(JSON.parse(raw));
  } catch {
    return {};
  }
}

function obj(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function cleanText(text: string, role: "user" | "assistant"): string {
  const trimmed = text.trim();
  if (role !== "user") return trimmed;
  if (!trimmed.startsWith("\"") || !trimmed.endsWith("\"")) return trimmed;

  try {
    const parsed = JSON.parse(trimmed);
    return typeof parsed === "string" ? parsed.trim() : trimmed;
  } catch {
    return trimmed;
  }
}

function classifyOpenCodeTool(tool: string): string {
  switch (tool.toLowerCase()) {
    case "write":
      return "write";
    case "edit":
      return "edit";
    case "bash":
      return "bash";
    default:
      return tool;
  }
}
