// Layer contracts — in-memory pipeline types and stored outputs.

import type { UUID, UnixMs, SessionOutcome } from "./core.js";
import type { WeightedMessage, ConversationPattern } from "./messages.js";
import type { ExtractedEvent } from "./events.js";

// ─── Layer 1 → Layer 2 contract (never stored) ───────────────────────────────

/** Everything Layer 1 produces; consumed by Layer 2 to build the digest. */
export interface Layer1Output {
  session_id: UUID;
  goal: string | null;
  weightedMessages: WeightedMessage[];
  events: ExtractedEvent[];
  decisions: string[];
  errors: string[];
  keywords: string[];
  patterns: ConversationPattern[];
  tokenCount: number;
}

// ─── Layer 2 — Digest (stored, injected into context) ─────────────────────────

/** Compact session summary kept under 500 tokens. Stored in DB. */
export interface Layer2Digest {
  id: UUID;
  session_id: UUID;                   // 1:1 with session
  goal: string | null;
  summary: string | null;
  files_modified: string[];
  decisions: string[];
  errors_encountered: string[];
  validation: string[];
  outcome: SessionOutcome | null;
  keywords: string[];
  estimated_tokens: number;           // must stay under 500
  created_at: UnixMs;
}

// ─── Layer 3 — Project memory (stored in projects.memory_doc) ─────────────────

export interface KnownIssue {
  id: UUID;
  project_id: UUID;
  description: string;
  detected_at: UnixMs;
  resolved_at: UnixMs | null;
  resolved_in_session: UUID | null;
}

export interface RecentWorkEntry {
  id: UUID;
  project_id: UUID;
  session_id: UUID;
  summary: string;
  date: UnixMs;
}

/** Assembled project memory — aggregated from digests and events. */
export interface ProjectMemory {
  project_id: UUID;
  memory_doc: string;
  architecture: string;
  how_to_test: string[];
  conventions: string[];
  known_issues: KnownIssue[];
  recent_work: RecentWorkEntry[];
  updated_at: UnixMs;
}
