// Events — ExtractedEvent and all payload types as a discriminated union.

import type { UUID, UnixMs } from "./core.js";
import type { PatternType } from "./messages.js";

export type EventSource = "hook" | "mcp";

// ─── Payload types (one interface per event type) ─────────────────────────────

export interface FilePayload {
  type: "file_created" | "file_modified";
  path: string;
  operation: string;
  diffSummary: string | null;
}

export interface CommandPayload {
  type: "command_run";
  command: string;
  exitCode: number;
  success: boolean;
  durationMs?: number;
  cwd?: string;
}

export interface DependencyPayload {
  type: "dependency_added";
  manager: string;
  package: string;
  version: string | null;
}

export interface CommitPayload {
  type: "commit";
  message: string;
  hash: string | null;
}

export interface ErrorPayload {
  type: "error";
  message: string;
  command: string | null;
  exitCode: number | null;
}

export interface DecisionPayload {
  type: "decision";
  content: string;
  confidence: number;
  triggeredByPattern: PatternType;
}

export interface BuildAttemptPayload {
  type: "build_attempt";
  command: string | null;
  success: boolean;
  durationMs: number | null;
  errorSummary: string | null;
}

export interface TestRunPayload {
  type: "test_run";
  command: string | null;
  passed: number;
  failed: number;
  durationMs: number | null;
}

export interface ConfigModifiedPayload {
  type: "config_modified";
  path: string;
  key: string | null;
}

// ─── Discriminated union ──────────────────────────────────────────────────────

export type EventPayload =
  | FilePayload
  | CommandPayload
  | DependencyPayload
  | CommitPayload
  | ErrorPayload
  | DecisionPayload
  | BuildAttemptPayload
  | TestRunPayload
  | ConfigModifiedPayload;

export type EventType = EventPayload["type"];

// ─── Stored event ─────────────────────────────────────────────────────────────

export interface ExtractedEvent {
  id: UUID;
  session_id: UUID;
  type: EventType;
  payload: EventPayload;  // stored as JSON in DB
  weight: number;         // 0.0–1.0
  timestamp: UnixMs;
  source: EventSource;
}
