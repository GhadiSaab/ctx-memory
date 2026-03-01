// known_issues and recent_work CRUD — the Layer 3 sub-tables.

import { db } from "./connection.js";
import type { KnownIssue, RecentWorkEntry, UUID, UnixMs } from "../types/index.js";
import { v4 as uuid } from "uuid";

// ─── Row mappings ─────────────────────────────────────────────────────────────

interface KnownIssueRow {
  id: string;
  project_id: string;
  description: string;
  detected_at: number;
  resolved_at: number | null;
  resolved_in_session: string | null;
}

interface RecentWorkRow {
  id: string;
  project_id: string;
  session_id: string;
  summary: string;
  date: number;
}

function rowToKnownIssue(row: KnownIssueRow): KnownIssue {
  return {
    id: row.id as UUID,
    project_id: row.project_id as UUID,
    description: row.description,
    detected_at: row.detected_at as UnixMs,
    resolved_at: row.resolved_at as UnixMs | null,
    resolved_in_session: row.resolved_in_session as UUID | null,
  };
}

function rowToRecentWork(row: RecentWorkRow): RecentWorkEntry {
  return {
    id: row.id as UUID,
    project_id: row.project_id as UUID,
    session_id: row.session_id as UUID,
    summary: row.summary,
    date: row.date as UnixMs,
  };
}

// ─── Statements ───────────────────────────────────────────────────────────────

const stmtInsertIssue = db.prepare(`
  INSERT INTO known_issues (id, project_id, description, detected_at, resolved_at, resolved_in_session)
  VALUES (@id, @project_id, @description, @detected_at, @resolved_at, @resolved_in_session)
`);

const stmtResolveIssue = db.prepare<[number, string, string]>(`
  UPDATE known_issues SET resolved_at = ?, resolved_in_session = ? WHERE id = ?
`);

const stmtGetOpenIssues = db.prepare<[string], KnownIssueRow>(`
  SELECT * FROM known_issues WHERE project_id = ? AND resolved_at IS NULL
  ORDER BY detected_at DESC
`);

const stmtGetAllIssues = db.prepare<[string], KnownIssueRow>(`
  SELECT * FROM known_issues WHERE project_id = ? ORDER BY detected_at DESC
`);

const stmtInsertRecentWork = db.prepare(`
  INSERT INTO recent_work (id, project_id, session_id, summary, date)
  VALUES (@id, @project_id, @session_id, @summary, @date)
`);

const stmtGetRecentWork = db.prepare<[string, number], RecentWorkRow>(`
  SELECT * FROM recent_work WHERE project_id = ? ORDER BY date DESC LIMIT ?
`);

const stmtDeleteOldRecentWork = db.prepare(`
  DELETE FROM recent_work WHERE project_id = ? AND id NOT IN (
    SELECT id FROM recent_work WHERE project_id = ? ORDER BY date DESC LIMIT ?
  )
`);

// ─── Known Issues ─────────────────────────────────────────────────────────────

export function createKnownIssue(fields: {
  project_id: UUID;
  description: string;
}): KnownIssue {
  const row: KnownIssueRow = {
    id: uuid(),
    project_id: fields.project_id,
    description: fields.description,
    detected_at: Date.now(),
    resolved_at: null,
    resolved_in_session: null,
  };
  stmtInsertIssue.run(row);
  return rowToKnownIssue(row);
}

export function resolveKnownIssue(issueId: UUID, sessionId: UUID): void {
  stmtResolveIssue.run(Date.now(), sessionId, issueId);
}

export function getOpenKnownIssues(projectId: UUID): KnownIssue[] {
  return stmtGetOpenIssues.all(projectId).map(rowToKnownIssue);
}

export function getAllKnownIssues(projectId: UUID): KnownIssue[] {
  return stmtGetAllIssues.all(projectId).map(rowToKnownIssue);
}

// ─── Recent Work ──────────────────────────────────────────────────────────────

export function addRecentWork(fields: {
  project_id: UUID;
  session_id: UUID;
  summary: string;
}): RecentWorkEntry {
  const row: RecentWorkRow = {
    id: uuid(),
    project_id: fields.project_id,
    session_id: fields.session_id,
    summary: fields.summary,
    date: Date.now(),
  };
  stmtInsertRecentWork.run(row);
  return rowToRecentWork(row);
}

export function getRecentWork(projectId: UUID, limit = 10): RecentWorkEntry[] {
  return stmtGetRecentWork.all(projectId, limit).map(rowToRecentWork);
}

/**
 * Prune entries beyond `maxEntries` — call after every addRecentWork
 * to enforce the config.max_recent_work_entries cap.
 */
export function pruneRecentWork(projectId: UUID, maxEntries: number): void {
  stmtDeleteOldRecentWork.run(projectId, projectId, maxEntries);
}
