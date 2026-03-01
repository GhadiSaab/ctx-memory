// Vector similarity search + keyword fallback search.

import { db } from "./connection.js";
import type { Session, UUID } from "../types/index.js";
import { getSessionById } from "./sessions.js";

// ─── Embedding search (sqlite-vec) ────────────────────────────────────────────

interface EmbeddingSearchRow {
  rowid: number;
  distance: number;
}

interface SessionProjectRow {
  id: string;
  project_id: string;
}

const stmtEmbeddingSearch = db.prepare<[Buffer, number], EmbeddingSearchRow>(`
  SELECT rowid, distance
  FROM session_embeddings
  WHERE embedding MATCH ?
  AND k = ?
  ORDER BY distance ASC
`);

const stmtGetSessionIds = db.prepare<[string], SessionProjectRow>(`
  SELECT id, project_id FROM sessions WHERE project_id = ?
`);

/**
 * Find sessions similar to a query vector, filtered to a specific project.
 * Returns sessions ordered by cosine similarity (closest first).
 *
 * Falls back to an empty array if no embeddings exist yet.
 */
export function searchByEmbedding(
  queryVector: Float32Array,
  projectId: UUID,
  limit = 5
): Session[] {
  // Get all session IDs for this project to use as a post-filter
  const projectSessionIds = new Set(
    stmtGetSessionIds.all(projectId).map((r) => r.id)
  );

  if (projectSessionIds.size === 0) return [];

  // sqlite-vec returns all vectors ranked by distance; we filter by project after
  const queryBuffer = Buffer.from(queryVector.buffer);
  const candidates = stmtEmbeddingSearch.all(queryBuffer, limit * 4); // over-fetch to allow filtering

  const results: Session[] = [];
  for (const candidate of candidates) {
    // rowid in session_embeddings matches the session rowid in sessions
    // We need to look up by rowid — use a separate query
    const session = getSessionByRowid(candidate.rowid);
    if (session && projectSessionIds.has(session.id)) {
      results.push(session);
      if (results.length >= limit) break;
    }
  }
  return results;
}

const stmtGetByRowid = db.prepare<[number], { id: string }>(`
  SELECT id FROM sessions WHERE rowid = ?
`);

function getSessionByRowid(rowid: number): Session | null {
  const row = stmtGetByRowid.get(rowid);
  if (!row) return null;
  return getSessionById(row.id as UUID);
}

// ─── Keyword search (fallback) ────────────────────────────────────────────────

interface KeywordSearchRow {
  id: string;
  project_id: string;
  keywords: string;
  goal: string | null;
  started_at: number;
}

const stmtKeywordSearch = db.prepare<[string, string, string, number], KeywordSearchRow>(`
  SELECT id, project_id, keywords, goal, started_at
  FROM sessions
  WHERE project_id = ?
    AND (
      keywords LIKE ?
      OR goal LIKE ?
    )
  ORDER BY started_at DESC
  LIMIT ?
`);

/**
 * Keyword fallback — LIKE match across sessions.keywords and sessions.goal.
 * Less accurate than embedding search but always available.
 */
export function searchByKeywords(
  query: string,
  projectId: UUID,
  limit = 5
): Session[] {
  const pattern = `%${query}%`;
  const rows = stmtKeywordSearch.all(projectId, pattern, pattern, limit);
  return rows
    .map((row) => getSessionById(row.id as UUID))
    .filter((s): s is Session => s !== null);
}
