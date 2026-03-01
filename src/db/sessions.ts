import { db } from "./connection.js";
import type { Session, UUID, UnixMs, ToolName, SessionOutcome } from "../types/index.js";
import { v4 as uuid } from "uuid";

// ─── Row mapping ──────────────────────────────────────────────────────────────

interface SessionRow {
  id: string;
  project_id: string;
  tool: string;
  started_at: number;
  ended_at: number | null;
  last_seen_at: number;
  outcome: string | null;
  exit_code: number | null;
  goal: string | null;
  keywords: string;       // JSON
  embedding: Buffer | null;
  message_count: number;
  duration_seconds: number | null;
}

function rowToSession(row: SessionRow): Session {
  return {
    id: row.id as UUID,
    project_id: row.project_id as UUID,
    tool: row.tool as ToolName,
    started_at: row.started_at as UnixMs,
    ended_at: row.ended_at as UnixMs | null,
    last_seen_at: row.last_seen_at as UnixMs,
    outcome: row.outcome as SessionOutcome | null,
    exit_code: row.exit_code,
    goal: row.goal,
    keywords: JSON.parse(row.keywords) as string[],
    embedding: row.embedding
      ? new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4)
      : null,
    message_count: row.message_count,
    duration_seconds: row.duration_seconds,
  };
}

// ─── Statements ───────────────────────────────────────────────────────────────

const stmtInsert = db.prepare(`
  INSERT INTO sessions
    (id, project_id, tool, started_at, ended_at, last_seen_at, outcome, exit_code,
     goal, keywords, embedding, message_count, duration_seconds)
  VALUES
    (@id, @project_id, @tool, @started_at, @ended_at, @last_seen_at, @outcome, @exit_code,
     @goal, @keywords, @embedding, @message_count, @duration_seconds)
`);

const stmtFindById = db.prepare<[string], SessionRow>(`
  SELECT * FROM sessions WHERE id = ?
`);

const stmtFindByProject = db.prepare<[string, number], SessionRow>(`
  SELECT * FROM sessions WHERE project_id = ? ORDER BY started_at DESC LIMIT ?
`);

const stmtHeartbeat = db.prepare<[number, string]>(`
  UPDATE sessions SET last_seen_at = ? WHERE id = ?
`);

const stmtIncrementMessageCount = db.prepare<[string]>(`
  UPDATE sessions SET message_count = message_count + 1 WHERE id = ?
`);

const stmtClose = db.prepare(`
  UPDATE sessions
  SET outcome = ?, exit_code = ?, ended_at = ?, duration_seconds = ?
  WHERE id = ?
`);

const stmtUpdateGoalAndKeywords = db.prepare(`
  UPDATE sessions SET goal = ?, keywords = ? WHERE id = ?
`);

const stmtUpdateEmbedding = db.prepare<[Buffer, string]>(`
  UPDATE sessions SET embedding = ? WHERE id = ?
`);

const stmtFindOrphans = db.prepare<[number], SessionRow>(`
  SELECT * FROM sessions WHERE outcome IS NULL AND last_seen_at < ?
`);

const stmtMarkCrashed = db.prepare(`
  UPDATE sessions SET outcome = 'crashed', ended_at = ? WHERE id = ? AND outcome IS NULL
`);

// ─── CRUD ─────────────────────────────────────────────────────────────────────

export function createSession(fields: {
  project_id: UUID;
  tool: ToolName;
}): Session {
  const now = Date.now() as UnixMs;
  const row = {
    id: uuid(),
    project_id: fields.project_id,
    tool: fields.tool,
    started_at: now,
    ended_at: null,
    last_seen_at: now,
    outcome: null,
    exit_code: null,
    goal: null,
    keywords: "[]",
    embedding: null,
    message_count: 0,
    duration_seconds: null,
  };
  stmtInsert.run(row);
  return rowToSession(row as SessionRow);
}

export function getSessionById(id: UUID): Session | null {
  const row = stmtFindById.get(id);
  return row ? rowToSession(row) : null;
}

export function getRecentSessionsByProject(projectId: UUID, limit = 10): Session[] {
  return stmtFindByProject.all(projectId, limit).map(rowToSession);
}

export function heartbeat(sessionId: UUID): void {
  stmtHeartbeat.run(Date.now(), sessionId);
}

export function incrementMessageCount(sessionId: UUID): void {
  stmtIncrementMessageCount.run(sessionId);
}

export function closeSession(
  sessionId: UUID,
  outcome: SessionOutcome,
  exitCode: number | null
): void {
  const now = Date.now();
  const session = getSessionById(sessionId);
  const durationSeconds = session
    ? Math.round((now - session.started_at) / 1000)
    : null;
  stmtClose.run(outcome, exitCode ?? null, now, durationSeconds, sessionId);
}

export function updateSessionGoalAndKeywords(
  sessionId: UUID,
  goal: string | null,
  keywords: string[]
): void {
  stmtUpdateGoalAndKeywords.run(goal, JSON.stringify(keywords), sessionId);
}

export function updateSessionEmbedding(sessionId: UUID, embedding: Float32Array): void {
  stmtUpdateEmbedding.run(Buffer.from(embedding.buffer), sessionId);
}

// ─── Orphan sweep ─────────────────────────────────────────────────────────────

/**
 * Finds sessions that never received a close event and marks them as crashed.
 * Returns the IDs so the caller can trigger digest generation for each.
 */
export function sweepOrphanedSessions(timeoutMinutes: number): UUID[] {
  const cutoff = Date.now() - timeoutMinutes * 60 * 1000;
  const orphans = stmtFindOrphans.all(cutoff);
  const now = Date.now();

  const closedIds: UUID[] = [];
  for (const orphan of orphans) {
    const result = stmtMarkCrashed.run(now, orphan.id);
    if (result.changes > 0) {
      closedIds.push(orphan.id as UUID);
    }
  }
  return closedIds;
}
