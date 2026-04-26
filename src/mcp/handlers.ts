// MCP tool handlers — pure async functions with no MCP SDK dependency.
// Tested directly; index.ts wires them into the MCP server.

import { z } from "zod";
import { createHash } from "node:crypto";
import type { Message, Project, UUID, ToolName } from "../types/index.js";
import {
  getProjectById,
  getProjectByPathHash,
  getProjectByName,
  getRecentSessionsByProject,
  ensureSession,
  closeSession,
  writeDigest,
  insertMessage,
  batchInsertMessages,
  batchInsertEvents,
  upsertMemoryDoc,
  updateSessionGoalAndKeywords,
  getDigestBySession,
  searchByKeywords,
  getConfig,
  getEventsBySession,
} from "../db/index.js";
import { classifyToolEvent } from "../layer1/events.js";
import { processSession } from "../layer1/combiner.js";
import { generateDigest } from "../layer2/digest.js";
import { summarizeLayer1 } from "../layer2/summarize.js";
import { mergeIntoProjectMemory, deserializeMemory } from "../layer3/memory.js";
import { embedText, storeEmbedding, searchSimilar } from "../db/embedding.js";
import type { ExtractedEvent } from "../types/index.js";

// ─── In-memory buffers (per session) ─────────────────────────────────────────

const messageBuffers = new Map<string, Message[]>();
const eventBuffers = new Map<string, ExtractedEvent[]>();

export function getMessageBuffer(sessionId: string): Message[] {
  return messageBuffers.get(sessionId) ?? [];
}

export function getEventBuffer(sessionId: string): ExtractedEvent[] {
  return eventBuffers.get(sessionId) ?? [];
}

export function clearBuffers(): void {
  messageBuffers.clear();
  eventBuffers.clear();
}

export function seedBuffers(sessionId: string, messages: Message[], events: ExtractedEvent[]): void {
  messageBuffers.set(sessionId, messages);
  eventBuffers.set(sessionId, events);
}

function pushMessage(sessionId: string, msg: Message): void {
  const buf = messageBuffers.get(sessionId) ?? [];
  buf.push(msg);
  messageBuffers.set(sessionId, buf);
}

function pushEvent(sessionId: string, evt: ExtractedEvent): void {
  const buf = eventBuffers.get(sessionId) ?? [];
  buf.push(evt);
  eventBuffers.set(sessionId, buf);
}

// ─── Input schemas ────────────────────────────────────────────────────────────

const StoreMessageSchema = z.object({
  session_id: z.string().min(1),
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  index: z.number().int().min(0),
});

const StoreEventSchema = z.object({
  session_id: z.string().min(1),
  tool: z.string().min(1),
  args: z.record(z.string(), z.unknown()).default({}),
  result: z.record(z.string(), z.unknown()).default({}),
  success: z.boolean().default(true),
});

const GetProjectMemorySchema = z.object({
  project_id: z.string().min(1).optional(),
});

const ListSessionsSchema = z.object({
  project_id: z.string().min(1).optional(),
  limit: z.number().int().positive().default(20),
});

const EndSessionSchema = z.object({
  session_id: z.string().min(1),
  project_id: z.string().min(1),
  tool: z.enum(["claude-code", "codex", "gemini", "opencode"]).optional(),
  outcome: z.enum(["completed", "interrupted", "crashed"]),
  exit_code: z.number().int().nullable().optional(),
});

const SearchContextSchema = z.object({
  query: z.string().min(1),
  project_id: z.string().min(1).optional(),
  limit: z.number().int().positive().default(5),
});

// ─── Error helpers ────────────────────────────────────────────────────────────

function err(message: string, code = "INTERNAL_ERROR") {
  return { error: message, code };
}

function resolveExistingProjectRef(projectRef: string): Project | null {
  let project = getProjectById(projectRef as UUID);
  if (project) return project;

  const pathHash = createHash("sha256").update(projectRef).digest("hex");
  project = getProjectByPathHash(pathHash);
  if (project) return project;

  return getProjectByName(projectRef);
}

function projectRefFromInput(projectId: string | undefined): string {
  return projectId ?? process.env["CTX_MEMORY_PROJECT_ID"] ?? process.env["LLM_MEMORY_PROJECT_ID"] ?? process.cwd();
}

function resolveInputProject(projectId: string | undefined): Project | null {
  return resolveExistingProjectRef(projectRefFromInput(projectId));
}

// ─── store_message ────────────────────────────────────────────────────────────

export async function handleStoreMessage(input: unknown) {
  const parsed = StoreMessageSchema.safeParse(input);
  if (!parsed.success) return err(parsed.error.message, "INVALID_INPUT");

  const { session_id, role, content, index } = parsed.data;
  const config = getConfig();

  const msg: Message = {
    id: crypto.randomUUID() as UUID,
    session_id: session_id as UUID,
    role,
    content,
    index,
    timestamp: Date.now() as any,
  };

  // Always buffer for Layer 1 processing at session end
  pushMessage(session_id, msg);

  // Optionally persist raw message to DB
  let stored = false;
  if (config.store_raw_messages) {
    try {
      insertMessage({ session_id: session_id as UUID, role, content, index });
      stored = true;
    } catch (e) {
      // Non-fatal — message still buffered for Layer 1
      console.error("[ctx-memory] store_message DB write failed:", e);
    }
  }

  return { stored };
}

// ─── store_event ──────────────────────────────────────────────────────────────

export async function handleStoreEvent(input: unknown) {
  const parsed = StoreEventSchema.safeParse(input);
  if (!parsed.success) return err(parsed.error.message, "INVALID_INPUT");

  const { session_id, tool, args, result, success } = parsed.data;

  try {
    const event = classifyToolEvent(tool, args, result as Record<string, unknown>, success);
    if (!event) return { queued: false };

    const stamped: ExtractedEvent = {
      ...event,
      session_id: session_id as UUID,
      timestamp: Date.now() as any,
    };
    pushEvent(session_id, stamped);
    return { queued: true };
  } catch (e) {
    console.error("[ctx-memory] store_event classification failed:", e);
    return err(String(e));
  }
}

// ─── get_project_memory ───────────────────────────────────────────────────────

export async function handleGetProjectMemory(input: unknown) {
  const parsed = GetProjectMemorySchema.safeParse(input);
  if (!parsed.success) return err(parsed.error.message, "INVALID_INPUT");

  const project = resolveInputProject(parsed.data.project_id);
  if (!project) return err("Project not found", "NOT_FOUND");

  return { memory_doc: project.memory_doc };
}

// ─── list_sessions ────────────────────────────────────────────────────────────

export async function handleListSessions(input: unknown) {
  const parsed = ListSessionsSchema.safeParse(input);
  if (!parsed.success) return err(parsed.error.message, "INVALID_INPUT");

  const { limit } = parsed.data;
  const project = resolveInputProject(parsed.data.project_id);
  if (!project) return err("Project not found", "NOT_FOUND");

  const sessions = getRecentSessionsByProject(project.id, limit);

  return {
    sessions: sessions.map((s) => ({
      id: s.id,
      goal: s.goal,
      outcome: s.outcome,
      started_at: s.started_at,
      duration_seconds: s.duration_seconds,
    })),
  };
}

// ─── search_context ───────────────────────────────────────────────────────────

export async function handleSearchContext(input: unknown) {
  const parsed = SearchContextSchema.safeParse(input);
  if (!parsed.success) return err(parsed.error.message, "INVALID_INPUT");

  const { query, limit } = parsed.data;
  const project = resolveInputProject(parsed.data.project_id);
  if (!project) return err("Project not found", "NOT_FOUND");
  const project_id = project.id;

  try {
    // Try embedding search first
    const queryVec = await embedText(query);
    const similar = searchSimilar(queryVec, project_id, limit);

    if (similar.length > 0) {
      const results = similar
        .map((s) => {
          const digest = getDigestBySession(s.sessionId as UUID);
          if (!digest) return null;
          return { session_id: s.sessionId, distance: s.distance, digest };
        })
        .filter(Boolean);
      return { results, method: "embedding" };
    }
  } catch {
    // Embedder not ready — fall through to keyword search
  }

  // Keyword fallback
  const sessions = searchByKeywords(query, project_id as UUID, limit);
  const results = sessions
    .map((s) => {
      const digest = getDigestBySession(s.id);
      if (!digest) return null;
      return { session_id: s.id, distance: null, digest };
    })
    .filter(Boolean);

  return { results, method: "keyword" };
}

// ─── end_session ──────────────────────────────────────────────────────────────

export async function handleEndSession(input: unknown) {
  const parsed = EndSessionSchema.safeParse(input);
  if (!parsed.success) return err(parsed.error.message, "INVALID_INPUT");

  const { session_id, project_id, tool, outcome, exit_code } = parsed.data;

  try {
    // 0. Ensure session exists in DB — create it if the shell wrapper never called session_start
    const project = getProjectById(project_id as UUID);
    if (!project) return err("Project not found", "NOT_FOUND");
    ensureSession({
      id: session_id,
      project_id: project_id as UUID,
      tool: (tool ?? "claude-code") as ToolName,
    });

    // 1. Drain buffers
    const messages = messageBuffers.get(session_id) ?? [];
    const events = eventBuffers.get(session_id) ?? [];

    // 2. Flush messages and events to DB
    if (messages.length > 0) {
      try {
        batchInsertMessages(messages);
      } catch (e) {
        console.error("[ctx-memory] message flush failed:", e);
      }
    }
    if (events.length > 0) {
      try {
        batchInsertEvents(events);
      } catch (e) {
        console.error("[ctx-memory] event flush failed:", e);
      }
    }

    // 3. Layer 1
    // Events may arrive through live hooks (already persisted) or buffered MCP/post-hoc
    // extraction. Read the DB after flushing so Layer 2 sees both paths.
    const layer1Raw = processSession(messages, []);
    layer1Raw.events = getEventsBySession(session_id as UUID);

    // 3.5. AI summarization (best-effort, requires ANTHROPIC_API_KEY)
    const layer1 = await summarizeLayer1(layer1Raw);

    // 4. Layer 2 — digest
    const digest = generateDigest(layer1, outcome, exit_code ?? null);
    writeDigest({
      session_id: session_id as UUID,
      goal: digest.goal,
      summary: digest.summary,
      files_modified: digest.files_modified,
      decisions: digest.decisions,
      errors_encountered: digest.errors_encountered,
      validation: digest.validation,
      facts: digest.facts,
      outcome: digest.outcome,
      keywords: digest.keywords,
      estimated_tokens: digest.estimated_tokens,
    });

    // 5. Update session record
    closeSession(session_id as UUID, outcome, exit_code ?? null);
    updateSessionGoalAndKeywords(session_id as UUID, layer1.goal, layer1.keywords);

    // 6. Generate and store embedding (best-effort)
    try {
      const embeddingText = [layer1.goal, ...layer1.keywords].filter(Boolean).join(" ");
      if (embeddingText.trim()) {
        const vector = await embedText(embeddingText);
        storeEmbedding(session_id, vector);
      }
    } catch (e) {
      console.error("[ctx-memory] embedding failed (non-fatal):", e);
    }

    // 7. Layer 3 — project memory
    try {
      // project was validated at step 0 above; re-fetch to get latest memory_doc
      const freshProject = getProjectById(project_id as UUID);
      if (freshProject) {
        const existing = freshProject.memory_doc
          ? deserializeMemory(freshProject.memory_doc!, project_id)
          : {
              project_id: project_id as UUID,
              memory_doc: "",
              architecture: "",
              how_to_test: [],
              conventions: [],
              known_issues: [],
              recent_work: [],
              updated_at: 0 as any,
            };
        const updated = mergeIntoProjectMemory(existing, digest, session_id);
        upsertMemoryDoc(project_id as UUID, updated.memory_doc);
      }
    } catch (e) {
      console.error("[ctx-memory] Layer 3 merge failed (non-fatal):", e);
    }

    // 8. Clear buffers
    messageBuffers.delete(session_id);
    eventBuffers.delete(session_id);

    return { ok: true };
  } catch (e) {
    console.error("[ctx-memory] end_session failed:", e);
    return err(String(e));
  }
}
