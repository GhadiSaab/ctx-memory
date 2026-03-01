// Raw message storage — opt-in, gated by config.store_raw_messages.

import { db } from "./connection.js";
import type { Message, MessageRole, UUID, UnixMs } from "../types/index.js";
import { v4 as uuid } from "uuid";

// ─── Row mapping ──────────────────────────────────────────────────────────────

interface MessageRow {
  id: string;
  session_id: string;
  role: string;
  content: string;
  index: number;
  timestamp: number;
}

function rowToMessage(row: MessageRow): Message {
  return {
    id: row.id as UUID,
    session_id: row.session_id as UUID,
    role: row.role as MessageRole,
    content: row.content,
    index: row.index,
    timestamp: row.timestamp as UnixMs,
  };
}

// ─── Statements ───────────────────────────────────────────────────────────────

const stmtInsert = db.prepare(`
  INSERT INTO messages_raw (id, session_id, role, content, \`index\`, timestamp)
  VALUES (@id, @session_id, @role, @content, @index, @timestamp)
`);

const stmtFindBySession = db.prepare<[string], MessageRow>(`
  SELECT * FROM messages_raw WHERE session_id = ? ORDER BY \`index\` ASC
`);

const stmtCountBySession = db.prepare<[string], { count: number }>(`
  SELECT COUNT(*) as count FROM messages_raw WHERE session_id = ?
`);

// ─── CRUD ─────────────────────────────────────────────────────────────────────

export function insertMessage(fields: {
  session_id: UUID;
  role: MessageRole;
  content: string;
  index: number;
}): Message {
  const row: MessageRow = {
    id: uuid(),
    session_id: fields.session_id,
    role: fields.role,
    content: fields.content,
    index: fields.index,
    timestamp: Date.now(),
  };
  stmtInsert.run(row);
  return rowToMessage(row);
}

/**
 * Batch insert — wrapped in a transaction.
 * Use when replaying a full conversation at session end.
 */
export const batchInsertMessages: (messages: Array<{
  session_id: UUID;
  role: MessageRole;
  content: string;
  index: number;
}>) => Message[] = db.transaction(
  (
    messages: Array<{
      session_id: UUID;
      role: MessageRole;
      content: string;
      index: number;
    }>
  ): Message[] => {
    return messages.map((m) => insertMessage(m));
  }
);

export function getMessagesBySession(sessionId: UUID): Message[] {
  return stmtFindBySession.all(sessionId).map(rowToMessage);
}

export function countMessagesBySession(sessionId: UUID): number {
  const row = stmtCountBySession.get(sessionId);
  return row?.count ?? 0;
}
