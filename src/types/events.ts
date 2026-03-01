// Events — ExtractedEvent and all payload types as a discriminated union.

import type { UUID, UnixMs } from "./core.js";

export type EventSource = "hook" | "mcp";

// ─── Payload types (one interface per event type) ─────────────────────────────

export interface FileModifiedPayload {
  type: "file_modified";
  path: string;
  changeType: "created" | "modified" | "deleted" | "renamed";
  previousPath?: string;  // only for renamed
}

export interface CommandPayload {
  type: "command_run";
  command: string;
  exitCode: number;
  durationMs: number;
  cwd: string;
}

export interface ErrorPayload {
  type: "error";
  message: string;
  stackTrace?: string;
  errorType?: string;
}

export interface DecisionPayload {
  type: "decision";
  summary: string;
  rationale?: string;
  alternatives?: string[];
}

export interface GoalPayload {
  type: "goal_set";
  goal: string;
  refinedFrom?: string;  // previous goal if this is a shift
}

export interface FactPayload {
  type: "fact";
  content: string;
  confidence: number;  // 0–1
}

export interface PreferencePayload {
  type: "preference";
  key: string;
  value: string;
}

export interface ToolCallPayload {
  type: "tool_call";
  toolName: string;
  input: Record<string, unknown>;
  success: boolean;
}

// ─── Discriminated union ──────────────────────────────────────────────────────

export type EventPayload =
  | FileModifiedPayload
  | CommandPayload
  | ErrorPayload
  | DecisionPayload
  | GoalPayload
  | FactPayload
  | PreferencePayload
  | ToolCallPayload;

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
