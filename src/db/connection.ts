// DB initialization — runs once at startup.
// Exports a single shared `db` instance used by all other db modules.

import Database, { type Database as DatabaseType } from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { homedir } from "os";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";

// ─── Path resolution ──────────────────────────────────────────────────────────

function resolveDbPath(raw: string): string {
  if (raw.startsWith("~/")) {
    return join(homedir(), raw.slice(2));
  }
  return raw;
}

const defaultDbPath = existsSync(resolveDbPath("~/.ctx-memory/store.db")) ||
  !existsSync(resolveDbPath("~/.llm-memory/store.db"))
  ? "~/.ctx-memory/store.db"
  : "~/.llm-memory/store.db";

const DB_PATH = resolveDbPath(
  process.env["CTX_MEMORY_DB_PATH"] || process.env["LLM_MEMORY_DB_PATH"] || defaultDbPath
);

const DB_DIR = DB_PATH.lastIndexOf("/") > 0
  ? DB_PATH.substring(0, DB_PATH.lastIndexOf("/"))
  : null;
if (DB_DIR) mkdirSync(DB_DIR, { recursive: true });

// ─── Connection ───────────────────────────────────────────────────────────────

const db: DatabaseType = new Database(DB_PATH);

// Load the sqlite-vec extension before any other setup
sqliteVec.load(db);

// Performance and correctness pragmas
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("synchronous = NORMAL"); // safe with WAL
db.pragma("temp_store = MEMORY");

// ─── Schema ───────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    path        TEXT NOT NULL,
    git_remote  TEXT UNIQUE,
    path_hash   TEXT NOT NULL UNIQUE,
    memory_doc  TEXT,
    updated_at  INTEGER NOT NULL,
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id               TEXT PRIMARY KEY,
    project_id       TEXT NOT NULL REFERENCES projects(id),
    tool             TEXT NOT NULL,
    started_at       INTEGER NOT NULL,
    ended_at         INTEGER,
    last_seen_at     INTEGER NOT NULL,
    outcome          TEXT,
    exit_code        INTEGER,
    goal             TEXT,
    keywords         TEXT NOT NULL DEFAULT '[]',
    embedding        BLOB,
    message_count    INTEGER NOT NULL DEFAULT 0,
    duration_seconds INTEGER
  );

  CREATE TABLE IF NOT EXISTS events (
    id         TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    type       TEXT NOT NULL,
    payload    TEXT NOT NULL,
    weight     REAL NOT NULL DEFAULT 0.5,
    timestamp  INTEGER NOT NULL,
    source     TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS digests (
    id                 TEXT PRIMARY KEY,
    session_id         TEXT NOT NULL UNIQUE REFERENCES sessions(id),
    goal               TEXT,
    summary            TEXT,
    files_modified     TEXT NOT NULL DEFAULT '[]',
    decisions          TEXT NOT NULL DEFAULT '[]',
    errors_encountered TEXT NOT NULL DEFAULT '[]',
    validation         TEXT NOT NULL DEFAULT '[]',
    facts              TEXT NOT NULL DEFAULT '[]',
    outcome            TEXT,
    keywords           TEXT NOT NULL DEFAULT '[]',
    estimated_tokens   INTEGER NOT NULL,
    created_at         INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages_raw (
    id         TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    role       TEXT NOT NULL,
    content    TEXT NOT NULL,
    \`index\`    INTEGER NOT NULL,
    timestamp  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS known_issues (
    id                  TEXT PRIMARY KEY,
    project_id          TEXT NOT NULL REFERENCES projects(id),
    description         TEXT NOT NULL,
    detected_at         INTEGER NOT NULL,
    resolved_at         INTEGER,
    resolved_in_session TEXT REFERENCES sessions(id)
  );

  CREATE TABLE IF NOT EXISTS recent_work (
    id         TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    session_id TEXT NOT NULL REFERENCES sessions(id),
    summary    TEXT NOT NULL,
    date       INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS config (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  -- sqlite-vec virtual table for session embeddings (384-dim all-MiniLM-L6-v2)
  CREATE VIRTUAL TABLE IF NOT EXISTS session_embeddings
    USING vec0(embedding FLOAT[384]);
`);

const digestColumns = db.prepare("PRAGMA table_info(digests)").all() as Array<{ name: string }>;
const digestColumnNames = new Set(digestColumns.map((column) => column.name));
if (!digestColumnNames.has("summary")) {
  db.exec("ALTER TABLE digests ADD COLUMN summary TEXT");
}
if (!digestColumnNames.has("validation")) {
  db.exec("ALTER TABLE digests ADD COLUMN validation TEXT NOT NULL DEFAULT '[]'");
}
if (!digestColumnNames.has("facts")) {
  db.exec("ALTER TABLE digests ADD COLUMN facts TEXT NOT NULL DEFAULT '[]'");
}

// ─── Indexes ──────────────────────────────────────────────────────────────────

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_sessions_project_started
    ON sessions(project_id, started_at DESC);

  CREATE INDEX IF NOT EXISTS idx_events_session
    ON events(session_id, timestamp ASC);

  CREATE INDEX IF NOT EXISTS idx_recent_work_project
    ON recent_work(project_id, date DESC);

  CREATE INDEX IF NOT EXISTS idx_known_issues_project
    ON known_issues(project_id, resolved_at);
`);

export { db };
export type { DatabaseType };
