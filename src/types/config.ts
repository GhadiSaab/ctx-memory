// Config and MCP tool contracts — validated by zod at runtime.

import { z } from "zod";
import type { UUID } from "./core.js";

// ─── User config ──────────────────────────────────────────────────────────────

export const ConfigSchema = z.object({
  db_path: z.string().default("~/.llm-memory/memory.db"),
  store_raw_messages: z.boolean().default(false),
  max_digest_tokens: z.number().int().positive().default(500),
  embedding_model: z.string().default("Xenova/all-MiniLM-L6-v2"),
  embedding_enabled: z.boolean().default(true),
  max_recent_work_entries: z.number().int().positive().default(10),
  log_level: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Config = z.infer<typeof ConfigSchema>;

// ─── MCP tool inputs ──────────────────────────────────────────────────────────

export const SessionStartInputSchema = z.object({
  project_path: z.string(),
  tool: z.enum(["claude-code", "codex", "gemini", "opencode"]),
  git_remote: z.string().nullable().optional(),
});

export const SessionEndInputSchema = z.object({
  session_id: z.uuid(),
  outcome: z.enum(["completed", "interrupted", "crashed"]),
  exit_code: z.number().int().nullable().optional(),
});

export const GetMemoryInputSchema = z.object({
  project_path: z.string(),
  include_recent_work: z.boolean().default(true),
  include_known_issues: z.boolean().default(true),
  max_digests: z.number().int().positive().default(5),
});

export const RecordEventInputSchema = z.object({
  session_id: z.uuid(),
  type: z.string(),
  payload: z.record(z.string(), z.unknown()),
  weight: z.number().min(0).max(1).optional(),
});

export type SessionStartInput = z.infer<typeof SessionStartInputSchema>;
export type SessionEndInput = z.infer<typeof SessionEndInputSchema>;
export type GetMemoryInput = z.infer<typeof GetMemoryInputSchema>;
export type RecordEventInput = z.infer<typeof RecordEventInputSchema>;

// ─── MCP tool outputs ─────────────────────────────────────────────────────────

export interface SessionStartOutput {
  session_id: UUID;
  project_id: UUID;
  memory_doc: string | null;   // injected into context immediately
}

export interface GetMemoryOutput {
  memory_doc: string | null;
  recent_digests: Array<{
    session_id: UUID;
    goal: string | null;
    outcome: string | null;
    date: number;
    summary: string;
  }>;
  known_issues: Array<{
    id: UUID;
    description: string;
    detected_at: number;
  }>;
}
