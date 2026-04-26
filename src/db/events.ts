import { db } from "./connection.js";
import type { ExtractedEvent, EventType, EventPayload, EventSource, UUID, UnixMs } from "../types/index.js";

// ─── Row mapping ──────────────────────────────────────────────────────────────

interface EventRow {
  id: string;
  session_id: string;
  type: string;
  payload: string; // JSON
  weight: number;
  timestamp: number;
  source: string;
}

function rowToEvent(row: EventRow): ExtractedEvent {
  return {
    id: row.id as UUID,
    session_id: row.session_id as UUID,
    type: row.type as EventType,
    payload: JSON.parse(row.payload) as EventPayload,
    weight: row.weight,
    timestamp: row.timestamp as UnixMs,
    source: row.source as EventSource,
  };
}

// ─── Statements ───────────────────────────────────────────────────────────────

const stmtInsert = db.prepare(`
  INSERT INTO events (id, session_id, type, payload, weight, timestamp, source)
  VALUES (@id, @session_id, @type, @payload, @weight, @timestamp, @source)
`);

const stmtFindBySession = db.prepare<[string], EventRow>(`
  SELECT * FROM events WHERE session_id = ? ORDER BY timestamp ASC
`);

const stmtFindBySessionAndType = db.prepare<[string, string], EventRow>(`
  SELECT * FROM events WHERE session_id = ? AND type = ? ORDER BY timestamp ASC
`);

// ─── CRUD ─────────────────────────────────────────────────────────────────────

export function insertEvent(fields: {
  session_id: UUID;
  type: EventType;
  payload: EventPayload;
  weight?: number;
  source: EventSource;
}): ExtractedEvent {
  const row: EventRow = {
    id: crypto.randomUUID(),
    session_id: fields.session_id,
    type: fields.type,
    payload: JSON.stringify(fields.payload),
    weight: fields.weight ?? 0.5,
    timestamp: Date.now(),
    source: fields.source,
  };
  stmtInsert.run(row);
  return rowToEvent(row);
}

/**
 * Batch insert — wrapped in a transaction for performance.
 * Use this when Layer 1 produces many events at once.
 */
export const batchInsertEvents: (events: Array<{
  session_id: UUID;
  type: EventType;
  payload: EventPayload;
  weight?: number;
  source: EventSource;
}>) => ExtractedEvent[] = db.transaction(
  (
    events: Array<{
      session_id: UUID;
      type: EventType;
      payload: EventPayload;
      weight?: number;
      source: EventSource;
    }>
  ): ExtractedEvent[] => {
    return events.map((e) => insertEvent(e));
  }
);

export function getEventsBySession(sessionId: UUID): ExtractedEvent[] {
  return stmtFindBySession.all(sessionId).map(rowToEvent);
}

export function getEventsBySessionAndType(
  sessionId: UUID,
  type: EventType
): ExtractedEvent[] {
  return stmtFindBySessionAndType.all(sessionId, type).map(rowToEvent);
}
