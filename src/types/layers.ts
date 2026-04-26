// Layer contracts — in-memory pipeline types and stored outputs.

import type { UUID, UnixMs, SessionOutcome } from "./core.js";
import type { WeightedMessage, ConversationPattern } from "./messages.js";
import type { ExtractedEvent } from "./events.js";

export type FactKind = "goal" | "decision" | "issue" | "work" | "validation" | "keyword";
export type FactSource = "user_message" | "assistant_message" | "tool_event" | "code_event";
export type FactDurability = "transient" | "session" | "project";
export type DecisionCategory = "architecture" | "convention" | "implementation";
export type IssueStatus = "open" | "resolved" | "transient";

export interface BaseFact {
  kind: FactKind;
  text: string;
  source: FactSource;
  sourceIndex?: number;
  confidence: number;
  durability: FactDurability;
}

export interface GoalFact extends BaseFact {
  kind: "goal";
}

export interface DecisionFact extends BaseFact {
  kind: "decision";
  category: DecisionCategory;
}

export interface IssueFact extends BaseFact {
  kind: "issue";
  status: IssueStatus;
  evidence?: string;
}

export interface WorkFact extends BaseFact {
  kind: "work";
}

export interface ValidationFact extends BaseFact {
  kind: "validation";
}

export interface KeywordFact extends BaseFact {
  kind: "keyword";
}

export type ExtractedFact =
  | GoalFact
  | DecisionFact
  | IssueFact
  | WorkFact
  | ValidationFact
  | KeywordFact;

// ─── Layer 1 → Layer 2 contract (never stored) ───────────────────────────────

/** Everything Layer 1 produces; consumed by Layer 2 to build the digest. */
export interface Layer1Output {
  session_id: UUID;
  goal: string | null;
  facts: ExtractedFact[];
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
  facts: ExtractedFact[];
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
