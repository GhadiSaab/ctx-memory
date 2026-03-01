// Core entities — Project and Session, plus their enums.
// Everything else in the system references these two.

export type UUID = string & { readonly _brand: "UUID" };
export type UnixMs = number & { readonly _brand: "UnixMs" };

// ─── Enums ────────────────────────────────────────────────────────────────────

export type ToolName = "claude-code" | "codex" | "gemini" | "opencode";

export type SessionOutcome = "completed" | "interrupted" | "crashed";

/** How the project was identified — used to pick the right lookup key. */
export type IdentityMethod = "git_remote" | "path_hash";

// ─── Project ──────────────────────────────────────────────────────────────────

export interface Project {
  id: UUID;
  name: string;          // repo or folder name
  path: string;          // absolute path on disk
  git_remote: string | null;  // canonical cross-machine ID (unique)
  path_hash: string;          // sha256 of path, fallback ID (unique)
  memory_doc: string | null;  // Layer 3 markdown document
  updated_at: UnixMs;
  created_at: UnixMs;
}

// ─── Session ──────────────────────────────────────────────────────────────────

export interface Session {
  id: UUID;
  project_id: UUID;
  tool: ToolName;
  started_at: UnixMs;
  ended_at: UnixMs | null;
  last_seen_at: UnixMs;
  outcome: SessionOutcome | null;
  exit_code: number | null;
  goal: string | null;         // extracted by Layer 1
  keywords: string[];          // JSON array stored in DB
  embedding: Float32Array | null;  // sqlite-vec blob, nullable
  message_count: number;
  duration_seconds: number | null;
}
