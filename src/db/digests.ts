import { db } from "./connection.js";
import type { Layer2Digest, UUID, UnixMs, SessionOutcome } from "../types/index.js";

// ─── Row mapping ──────────────────────────────────────────────────────────────

interface DigestRow {
  id: string;
  session_id: string;
  goal: string | null;
  summary: string | null;
  files_modified: string;     // JSON
  decisions: string;          // JSON
  errors_encountered: string; // JSON
  validation: string;         // JSON
  facts: string;              // JSON
  outcome: string | null;
  keywords: string;           // JSON
  estimated_tokens: number;
  created_at: number;
}

function rowToDigest(row: DigestRow): Layer2Digest {
  return {
    id: row.id as UUID,
    session_id: row.session_id as UUID,
    goal: row.goal,
    summary: row.summary,
    files_modified: JSON.parse(row.files_modified) as string[],
    decisions: JSON.parse(row.decisions) as string[],
    errors_encountered: JSON.parse(row.errors_encountered) as string[],
    validation: JSON.parse(row.validation) as string[],
    facts: JSON.parse(row.facts) as Layer2Digest["facts"],
    outcome: row.outcome as SessionOutcome | null,
    keywords: JSON.parse(row.keywords) as string[],
    estimated_tokens: row.estimated_tokens,
    created_at: row.created_at as UnixMs,
  };
}

// ─── Statements ───────────────────────────────────────────────────────────────

const stmtInsert = db.prepare(`
  INSERT INTO digests
    (id, session_id, goal, summary, files_modified, decisions, errors_encountered,
     validation, facts, outcome, keywords, estimated_tokens, created_at)
  VALUES
    (@id, @session_id, @goal, @summary, @files_modified, @decisions, @errors_encountered,
     @validation, @facts, @outcome, @keywords, @estimated_tokens, @created_at)
`);

const stmtFindBySession = db.prepare<[string], DigestRow>(`
  SELECT * FROM digests WHERE session_id = ?
`);

const stmtFindRecentByProject = db.prepare<[string, number], DigestRow>(`
  SELECT d.* FROM digests d
  JOIN sessions s ON s.id = d.session_id
  WHERE s.project_id = ?
  ORDER BY d.created_at DESC
  LIMIT ?
`);

// ─── CRUD ─────────────────────────────────────────────────────────────────────

export function writeDigest(
  fields: Omit<Layer2Digest, "id" | "created_at" | "summary" | "validation" | "facts"> &
    Partial<Pick<Layer2Digest, "summary" | "validation" | "facts">>
): Layer2Digest {
  const row: DigestRow = {
    id: crypto.randomUUID(),
    session_id: fields.session_id,
    goal: fields.goal,
    summary: fields.summary ?? fields.goal,
    files_modified: JSON.stringify(fields.files_modified),
    decisions: JSON.stringify(fields.decisions),
    errors_encountered: JSON.stringify(fields.errors_encountered),
    validation: JSON.stringify(fields.validation ?? []),
    facts: JSON.stringify(fields.facts ?? []),
    outcome: fields.outcome,
    keywords: JSON.stringify(fields.keywords),
    estimated_tokens: fields.estimated_tokens,
    created_at: Date.now(),
  };
  stmtInsert.run(row);
  return rowToDigest(row);
}

export function getDigestBySession(sessionId: UUID): Layer2Digest | null {
  const row = stmtFindBySession.get(sessionId);
  return row ? rowToDigest(row) : null;
}

export function getRecentDigestsByProject(
  projectId: UUID,
  limit = 5
): Layer2Digest[] {
  return stmtFindRecentByProject.all(projectId, limit).map(rowToDigest);
}
