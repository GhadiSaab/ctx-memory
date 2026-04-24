// Antigravity session reader — extracts messages from Antigravity's VS Code-based
// state DB after a session ends.
//
// Antigravity stores workspace state in:
//   ~/.config/Antigravity/User/workspaceStorage/<hash>/state.vscdb  — SQLite
//
// The workspace hash is matched by reading workspace.json in each subdirectory
// and comparing the `folder` field (a file:// URI) to the project cwd.
//
// Chat sessions are stored in the ItemTable under key `chat.ChatSessionStore.index`.

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import DatabaseConstructor from "better-sqlite3";
import type { Message, UUID, UnixMs } from "../types/index.js";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ChatRequest {
  message?: { text?: string };
  response?: { value?: Array<{ value?: string }> };
  timestamp?: number;
}

interface ChatSession {
  sessionId?: string;
  creationDate?: number;
  requests?: ChatRequest[];
}

interface ChatSessionIndex {
  version?: number;
  entries?: Record<string, ChatSession>;
}

// ─── findWorkspaceHash ────────────────────────────────────────────────────────

/**
 * Scans storageDir for a subdirectory whose workspace.json `folder` field
 * (a file:// URI) matches cwd. Returns the subdirectory name (hash) or null.
 */
export function findWorkspaceHash(storageDir: string, cwd: string): string | null {
  try {
    const entries = readdirSync(storageDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const workspacePath = join(storageDir, entry.name, "workspace.json");
      if (!existsSync(workspacePath)) continue;
      let raw: string;
      try {
        raw = readFileSync(workspacePath, "utf8");
      } catch {
        continue;
      }
      try {
        const parsed = JSON.parse(raw) as { folder?: string };
        const folder = parsed.folder;
        if (typeof folder !== "string") continue;
        // Decode file:// URI to a filesystem path
        if (!folder.startsWith("file://")) continue;
        const decoded = decodeURIComponent(folder.slice("file://".length));
        // Normalize trailing slashes for comparison
        const normalizedDecoded = decoded.replace(/\/+$/, "");
        const normalizedCwd = cwd.replace(/\/+$/, "");
        if (normalizedDecoded === normalizedCwd) {
          return entry.name;
        }
      } catch {
        continue;
      }
    }
  } catch {
    /* storageDir missing or unreadable — return null */
  }
  return null;
}

// ─── readAntigravitySession ───────────────────────────────────────────────────

/**
 * Reads Antigravity chat session data for the given project cwd, filtered to
 * sessions/requests that started at or after sessionStartMs.
 *
 * Returns { messages: [] } on any error or if no matching data is found.
 */
export function readAntigravitySession(
  cwd: string,
  sessionStartMs: number,
  storageDir?: string
): { messages: Message[] } {
  const resolvedStorageDir =
    storageDir ?? join(homedir(), ".config", "Antigravity", "User", "workspaceStorage");

  const hash = findWorkspaceHash(resolvedStorageDir, cwd);
  if (!hash) return { messages: [] };

  const dbPath = join(resolvedStorageDir, hash, "state.vscdb");
  if (!existsSync(dbPath)) return { messages: [] };

  let db: ReturnType<typeof DatabaseConstructor> | null = null;
  try {
    db = new DatabaseConstructor(dbPath, { readonly: true, fileMustExist: true });

    const row = db
      .prepare<[string], { value: string }>(
        `SELECT value FROM ItemTable WHERE key = ?`
      )
      .get("chat.ChatSessionStore.index");

    if (!row || typeof row.value !== "string") return { messages: [] };

    let index: ChatSessionIndex;
    try {
      index = JSON.parse(row.value) as ChatSessionIndex;
    } catch {
      return { messages: [] };
    }

    if (!index.entries || typeof index.entries !== "object") return { messages: [] };

    const messages: Message[] = [];
    const fakeSessionId = "00000000-0000-0000-0000-000000000000" as UUID;
    const now = Date.now() as UnixMs;
    let messageIndex = 0;

    for (const session of Object.values(index.entries)) {
      if (!session || typeof session !== "object") continue;

      const requests = session.requests;
      if (!Array.isArray(requests)) continue;

      for (const request of requests) {
        if (!request || typeof request !== "object") continue;

        // Use request.timestamp if available, fall back to session creationDate
        const ts =
          typeof request.timestamp === "number"
            ? request.timestamp
            : typeof session.creationDate === "number"
            ? session.creationDate
            : 0;

        if (ts < sessionStartMs) continue;

        // Extract user message text
        const userText = request.message?.text;
        if (typeof userText !== "string" || !userText.trim()) continue;

        // Extract assistant response text
        const responseValues = request.response?.value;
        if (!Array.isArray(responseValues) || responseValues.length === 0) continue;
        const assistantText = responseValues[0]?.value;
        if (typeof assistantText !== "string" || !assistantText.trim()) continue;

        messages.push({
          id: randomUUID() as UUID,
          session_id: fakeSessionId,
          role: "user",
          content: userText,
          index: messageIndex++,
          timestamp: now,
        });

        messages.push({
          id: randomUUID() as UUID,
          session_id: fakeSessionId,
          role: "assistant",
          content: assistantText,
          index: messageIndex++,
          timestamp: now,
        });
      }
    }

    return { messages };
  } catch {
    return { messages: [] };
  } finally {
    db?.close();
  }
}
