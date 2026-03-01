import { db } from "./connection.js";
import type { Project, UUID, UnixMs } from "../types/index.js";
import { v4 as uuid } from "uuid";

// ─── Row mapping ──────────────────────────────────────────────────────────────

interface ProjectRow {
  id: string;
  name: string;
  path: string;
  git_remote: string | null;
  path_hash: string;
  memory_doc: string | null;
  updated_at: number;
  created_at: number;
}

function rowToProject(row: ProjectRow): Project {
  return {
    id: row.id as UUID,
    name: row.name,
    path: row.path,
    git_remote: row.git_remote,
    path_hash: row.path_hash,
    memory_doc: row.memory_doc,
    updated_at: row.updated_at as UnixMs,
    created_at: row.created_at as UnixMs,
  };
}

// ─── Statements ───────────────────────────────────────────────────────────────

const stmtInsert = db.prepare<ProjectRow>(`
  INSERT INTO projects (id, name, path, git_remote, path_hash, memory_doc, updated_at, created_at)
  VALUES (@id, @name, @path, @git_remote, @path_hash, @memory_doc, @updated_at, @created_at)
`);

const stmtFindById = db.prepare<[string], ProjectRow>(`
  SELECT * FROM projects WHERE id = ?
`);

const stmtFindByGitRemote = db.prepare<[string], ProjectRow>(`
  SELECT * FROM projects WHERE git_remote = ?
`);

const stmtFindByPathHash = db.prepare<[string], ProjectRow>(`
  SELECT * FROM projects WHERE path_hash = ?
`);

const stmtUpdateMemoryDoc = db.prepare<[string, number, string]>(`
  UPDATE projects SET memory_doc = ?, updated_at = ? WHERE id = ?
`);

const stmtUpdatePath = db.prepare<[string, string, number, string]>(`
  UPDATE projects SET path = ?, name = ?, updated_at = ? WHERE id = ?
`);

// ─── CRUD ─────────────────────────────────────────────────────────────────────

export function createProject(fields: {
  name: string;
  path: string;
  git_remote: string | null;
  path_hash: string;
}): Project {
  const now = Date.now() as UnixMs;
  const row: ProjectRow = {
    id: uuid(),
    name: fields.name,
    path: fields.path,
    git_remote: fields.git_remote,
    path_hash: fields.path_hash,
    memory_doc: null,
    updated_at: now,
    created_at: now,
  };
  stmtInsert.run(row);
  return rowToProject(row);
}

export function getProjectById(id: UUID): Project | null {
  const row = stmtFindById.get(id);
  return row ? rowToProject(row) : null;
}

export function getProjectByGitRemote(gitRemote: string): Project | null {
  const row = stmtFindByGitRemote.get(gitRemote);
  return row ? rowToProject(row) : null;
}

export function getProjectByPathHash(pathHash: string): Project | null {
  const row = stmtFindByPathHash.get(pathHash);
  return row ? rowToProject(row) : null;
}

export function upsertMemoryDoc(projectId: UUID, memoryDoc: string): void {
  stmtUpdateMemoryDoc.run(memoryDoc, Date.now(), projectId);
}

export function updateProjectPath(projectId: UUID, path: string, name: string): void {
  stmtUpdatePath.run(path, name, Date.now(), projectId);
}
