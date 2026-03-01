import { describe, it, expect, beforeEach } from "vitest";
import { db } from "../../src/db/connection.js";
import {
  updateSessionEmbedding,
  searchByEmbedding,
  searchByKeywords,
  updateSessionGoalAndKeywords,
} from "../../src/db/index.js";
import { clearDb, seedProject, seedSession } from "./helpers.js";

const DIM = 384;

/** Build a unit-normalized Float32Array pointing mostly in one direction. */
function makeVector(primaryDim: number, value = 1.0): Float32Array {
  const v = new Float32Array(DIM);
  v[primaryDim] = value;
  // Normalize
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / norm);
}

/** Insert an embedding row into session_embeddings (sqlite-vec rowid must match sessions rowid). */
function storeEmbedding(sessionId: string, vec: Float32Array): void {
  // Get the rowid of the session row
  const row = db.prepare<[string], { rowid: number }>(
    "SELECT rowid FROM sessions WHERE id = ?"
  ).get(sessionId);
  if (!row) throw new Error(`Session ${sessionId} not found`);

  // sqlite-vec vec0 requires BigInt for the rowid primary key
  db.prepare(
    "INSERT INTO session_embeddings(rowid, embedding) VALUES (?, ?)"
  ).run(BigInt(row.rowid), Buffer.from(vec.buffer));

  // Also persist to sessions.embedding column so getSessionById returns it
  updateSessionEmbedding(sessionId as any, vec);
}

beforeEach(clearDb);

describe("searchByEmbedding", () => {
  it("returns sessions ordered by similarity — closest vector first", () => {
    const project = seedProject();
    const close = seedSession(project.id);   // vector near query
    const far = seedSession(project.id);     // vector far from query

    // Query points at dimension 0
    const query = makeVector(0);
    storeEmbedding(close.id, makeVector(0));   // identical direction → distance ≈ 0
    storeEmbedding(far.id, makeVector(100));   // orthogonal → distance ≈ 1

    const results = searchByEmbedding(query, project.id, 5);

    expect(results).toHaveLength(2);
    expect(results[0].id).toBe(close.id);
    expect(results[1].id).toBe(far.id);
  });

  it("respects the limit parameter", () => {
    const project = seedProject();
    const sessions = [
      seedSession(project.id),
      seedSession(project.id),
      seedSession(project.id),
    ];

    const query = makeVector(0);
    for (let i = 0; i < sessions.length; i++) {
      storeEmbedding(sessions[i].id, makeVector(i * 10));
    }

    const results = searchByEmbedding(query, project.id, 2);
    expect(results).toHaveLength(2);
  });

  it("only returns sessions belonging to the requested project", () => {
    const p1 = seedProject({ path_hash: "ph1" });
    const p2 = seedProject({ path_hash: "ph2" });
    const s1 = seedSession(p1.id);
    const s2 = seedSession(p2.id);

    storeEmbedding(s1.id, makeVector(0));
    storeEmbedding(s2.id, makeVector(0)); // same vector, different project

    const results = searchByEmbedding(makeVector(0), p1.id, 10);
    expect(results.every((s) => s.project_id === p1.id)).toBe(true);
    expect(results.map((s) => s.id)).not.toContain(s2.id);
  });

  it("returns empty array when no embeddings exist for the project", () => {
    const project = seedProject();
    seedSession(project.id); // no embedding stored
    const results = searchByEmbedding(makeVector(0), project.id, 5);
    expect(results).toEqual([]);
  });
});

describe("searchByKeywords", () => {
  it("matches sessions by goal substring", () => {
    const project = seedProject();
    const s = seedSession(project.id);
    updateSessionGoalAndKeywords(s.id, "Refactor the auth module", ["auth"]);

    const results = searchByKeywords("auth module", project.id, 10);
    expect(results.map((r) => r.id)).toContain(s.id);
  });

  it("matches sessions by keywords JSON substring", () => {
    const project = seedProject();
    const s = seedSession(project.id);
    updateSessionGoalAndKeywords(s.id, null, ["sqlite", "vector", "search"]);

    const results = searchByKeywords("vector", project.id, 10);
    expect(results.map((r) => r.id)).toContain(s.id);
  });

  it("does not return sessions from other projects", () => {
    const p1 = seedProject({ path_hash: "ph1" });
    const p2 = seedProject({ path_hash: "ph2" });
    const s2 = seedSession(p2.id);
    updateSessionGoalAndKeywords(s2.id, "target keyword here", []);

    const results = searchByKeywords("target keyword", p1.id, 10);
    expect(results.map((r) => r.id)).not.toContain(s2.id);
  });

  it("returns empty array when nothing matches", () => {
    const project = seedProject();
    seedSession(project.id);
    expect(searchByKeywords("zxqwerty", project.id, 10)).toEqual([]);
  });

  it("respects the limit parameter", () => {
    const project = seedProject();
    const sessions = [
      seedSession(project.id),
      seedSession(project.id),
      seedSession(project.id),
    ];
    for (const s of sessions) {
      updateSessionGoalAndKeywords(s.id, "matching goal", []);
    }

    const results = searchByKeywords("matching", project.id, 2);
    expect(results).toHaveLength(2);
  });
});
