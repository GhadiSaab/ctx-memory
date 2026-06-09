// Embedding helpers — MiniLM model loading, text embedding, storage, and similarity search.
// loadEmbedder() must be called once at MCP server startup before any embedText() calls.

import { pipeline } from "@xenova/transformers";
import { db } from "./connection.js";
import { updateSessionEmbedding } from "./sessions.js";
import type { UUID } from "../types/index.js";

// ─── Model state ──────────────────────────────────────────────────────────────

let embedder: Awaited<ReturnType<typeof pipeline>> | null = null;

/**
 * Preload the all-MiniLM-L6-v2 model.
 * Downloads ~22MB on first use, cached in ~/.cache/huggingface/.
 * Subsequent startups load from cache in ~1-3 seconds.
 */
export async function loadEmbedder(): Promise<void> {
  embedder = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
}

// ─── Text → vector ────────────────────────────────────────────────────────────

/**
 * Embed a text string using the preloaded MiniLM model.
 * Returns a normalized 384-dimensional Float32Array.
 */
export async function embedText(text: string): Promise<Float32Array> {
  if (!embedder) throw new Error("Embedder not loaded — call loadEmbedder() first");

   
  const output = await (embedder as any)(text, { pooling: "mean", normalize: true });
  // @xenova/transformers returns a Tensor; .data is a Float32Array
  return (output as any).data as Float32Array;
}

// ─── Storage ──────────────────────────────────────────────────────────────────

const stmtGetRowid = db.prepare<[string], { rowid: number }>(
  "SELECT rowid FROM sessions WHERE id = ?"
);

const stmtInsertEmbedding = db.prepare(
  "INSERT OR REPLACE INTO session_embeddings(rowid, embedding) VALUES (?, ?)"
);

/**
 * Store a session embedding in both session_embeddings (for ANN search)
 * and sessions.embedding (for retrieval via getSessionById).
 * Throws if the session does not exist.
 */
export function storeEmbedding(sessionId: string, vector: Float32Array): void {
  const row = stmtGetRowid.get(sessionId);
  if (!row) throw new Error(`Session not found: ${sessionId}`);

  const buf = Buffer.from(vector.buffer);
  // sqlite-vec vec0 requires BigInt for the rowid primary key
  stmtInsertEmbedding.run(BigInt(row.rowid), buf);

  // Also persist to sessions.embedding so getSessionById returns it
  updateSessionEmbedding(sessionId as UUID, vector);
}

// ─── Similarity search ────────────────────────────────────────────────────────

export interface SimilarSession {
  sessionId: string;
  distance: number;
}

// stmtSearch kept for future similarity search — prefix _ to mark intentionally unused
const _stmtSearch = db.prepare<[Buffer, number], { id: string; distance: number }>(`
  SELECT s.id, ev.distance
  FROM session_embeddings ev
  JOIN sessions s ON s.rowid = ev.rowid
  WHERE s.project_id = ?
    AND ev.embedding MATCH ?
    AND k = ?
  ORDER BY ev.distance
`);

// better-sqlite3 doesn't support named params mixed with positional in vec0 MATCH,
// so we use a wrapper that binds project_id in the WHERE via a separate filter.
// sqlite-vec doesn't support parameterised WHERE on non-vector columns inside the MATCH
// clause — we fetch k*4 candidates globally, then post-filter by project.
const stmtSearchAll = db.prepare<[Buffer, number], { id: string; distance: number; project_id: string }>(`
  SELECT s.id, s.project_id, ev.distance
  FROM session_embeddings ev
  JOIN sessions s ON s.rowid = ev.rowid
  WHERE ev.embedding MATCH ?
    AND k = ?
  ORDER BY ev.distance
`);

/**
 * Find sessions similar to a query vector, filtered to the given project.
 * Returns results ordered by L2 distance (lowest = most similar).
 */
export function searchSimilar(
  queryVector: Float32Array,
  projectId: string,
  limit: number
): SimilarSession[] {
  const queryBuffer = Buffer.from(queryVector.buffer);
  // Over-fetch to allow project-level post-filtering
  const candidates = stmtSearchAll.all(queryBuffer, limit * 4);

  const results: SimilarSession[] = [];
  for (const c of candidates) {
    if (c.project_id !== projectId) continue;
    results.push({ sessionId: c.id, distance: c.distance });
    if (results.length >= limit) break;
  }
  return results;
}
