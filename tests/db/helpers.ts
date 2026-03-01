// Shared test utilities — import in every db test file.

import { db } from "../../src/db/connection.js";
import type { UUID } from "../../src/types/index.js";
import {
  createProject,
  createSession,
} from "../../src/db/index.js";

/** Wipe all rows in dependency order so FK constraints don't fire. */
export function clearDb(): void {
  db.exec(`
    DELETE FROM recent_work;
    DELETE FROM known_issues;
    DELETE FROM digests;
    DELETE FROM events;
    DELETE FROM messages_raw;
    DELETE FROM sessions;
    DELETE FROM projects;
    DELETE FROM config;
  `);
  // session_embeddings is a virtual table — vec0 supports DELETE
  db.exec(`DELETE FROM session_embeddings;`);
}

/** Create a throwaway project for tests that just need a valid project_id. */
export function seedProject(overrides: { git_remote?: string | null; path_hash?: string } = {}) {
  return createProject({
    name: "test-project",
    path: "/home/user/test-project",
    git_remote: overrides.git_remote ?? null,
    path_hash: overrides.path_hash ?? `hash-${Math.random()}`,
  });
}

/** Create a throwaway session for tests that just need a valid session_id. */
export function seedSession(projectId: UUID) {
  return createSession({ project_id: projectId, tool: "claude-code" });
}
