// MCP server integration tests.
// These test the handler functions directly, not the MCP wire protocol.

import { describe, it, expect, beforeEach } from "vitest";
import { clearDb, seedProject, seedSession } from "../db/helpers.js";
import {
  handleStoreMessage,
  handleStoreEvent,
  handleGetProjectMemory,
  handleListSessions,
  handleEndSession,
  getMessageBuffer,
  getEventBuffer,
  clearBuffers,
} from "../../src/mcp/handlers.js";
import {
  updateSessionGoalAndKeywords,
  upsertMemoryDoc,
  getProjectById,
  getDigestBySession,
  getSessionById,
  setConfigValue,
} from "../../src/db/index.js";

// Helper: cast handler result for property access in tests
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function r(v: unknown): any { return v; }

beforeEach(() => {
  clearDb();
  clearBuffers();
});

// ─── store_message ────────────────────────────────────────────────────────────

describe("handleStoreMessage", () => {
  it("buffers the message and returns { stored: false } when store_raw_messages is off (default)", async () => {
    const project = seedProject();
    const session = seedSession(project.id);

    const result = r(await handleStoreMessage({
      session_id: session.id,
      role: "user",
      content: "fix the login bug",
      index: 0,
    }));

    // store_raw_messages defaults to false → not written to DB
    expect(result.stored).toBe(false);
    // but always buffered in memory for Layer 1
    expect(getMessageBuffer(session.id)).toHaveLength(1);
  });

  it("returns { stored: true } when store_raw_messages is enabled", async () => {
    setConfigValue("store_raw_messages", true);
    const project = seedProject();
    const session = seedSession(project.id);

    const result = r(await handleStoreMessage({
      session_id: session.id,
      role: "user",
      content: "fix the login bug",
      index: 0,
    }));

    expect(result.stored).toBe(true);
    expect(getMessageBuffer(session.id)).toHaveLength(1);
  });

  it("buffers multiple messages in order", async () => {
    const project = seedProject();
    const session = seedSession(project.id);

    await handleStoreMessage({ session_id: session.id, role: "user", content: "first", index: 0 });
    await handleStoreMessage({ session_id: session.id, role: "assistant", content: "second", index: 1 });

    const buf = getMessageBuffer(session.id);
    expect(buf).toHaveLength(2);
    expect(buf[0].content).toBe("first");
    expect(buf[1].content).toBe("second");
  });

  it("returns an error object for missing required fields", async () => {
    // missing role, content, index
    const result = await handleStoreMessage({ session_id: "abc" });
    expect(result).toHaveProperty("error");
  });
});

// ─── store_event ──────────────────────────────────────────────────────────────

describe("handleStoreEvent", () => {
  it("returns { queued: true } and buffers the classified event", async () => {
    const project = seedProject();
    const session = seedSession(project.id);

    const result = r(await handleStoreEvent({
      session_id: session.id,
      tool: "bash",
      args: { command: "git commit -m 'initial commit'" },
      result: { output: "abc1234 initial commit" },
      success: true,
    }));

    expect(result.queued).toBe(true);
    expect(getEventBuffer(session.id)).toHaveLength(1);
    expect(getEventBuffer(session.id)[0].type).toBe("commit");
  });

  it("returns { queued: false } for unrecognised tool types (still no error)", async () => {
    const project = seedProject();
    const session = seedSession(project.id);

    const result = r(await handleStoreEvent({
      session_id: session.id,
      tool: "unknown_tool_xyz",
      args: {},
      result: {},
      success: true,
    }));

    // Classifier returns null for unknown tools — nothing queued
    expect(result.queued).toBe(false);
    expect(getEventBuffer(session.id)).toHaveLength(0);
  });

  it("returns an error object for invalid input without crashing", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await handleStoreEvent({} as any);
    expect(result).toHaveProperty("error");
  });
});

// ─── get_project_memory ───────────────────────────────────────────────────────

describe("handleGetProjectMemory", () => {
  it("returns the memory_doc stored in the project", async () => {
    const project = seedProject();
    upsertMemoryDoc(project.id, "# Project Memory\n\n## Architecture\n- uses SQLite");

    const result = r(await handleGetProjectMemory({ project_id: project.id }));
    expect(result.memory_doc).toContain("uses SQLite");
  });

  it("returns null memory_doc when no memory has been written yet", async () => {
    const project = seedProject();
    const result = r(await handleGetProjectMemory({ project_id: project.id }));
    expect(result.memory_doc).toBeNull();
  });

  it("returns an error for an unknown project_id", async () => {
    const result = await handleGetProjectMemory({ project_id: "non-existent-id" });
    expect(result).toHaveProperty("error");
  });
});

// ─── list_sessions ────────────────────────────────────────────────────────────

describe("handleListSessions", () => {
  it("falls back to CTX_MEMORY_PROJECT_ID when no project_id is provided", async () => {
    const project = seedProject();
    const session = seedSession(project.id);
    process.env["CTX_MEMORY_PROJECT_ID"] = project.id;

    try {
      const result = r(await handleListSessions({}));
      expect(result.sessions.map((s: any) => s.id)).toContain(session.id);
    } finally {
      delete process.env["CTX_MEMORY_PROJECT_ID"];
    }
  });

  it("returns a summary list for the given project", async () => {
    const project = seedProject();
    const s1 = seedSession(project.id);
    const s2 = seedSession(project.id);
    updateSessionGoalAndKeywords(s1.id as any, "fix the login bug", ["auth"]);
    updateSessionGoalAndKeywords(s2.id as any, "add dark mode", ["ui"]);

    const result = r(await handleListSessions({ project_id: project.id }));

    expect(result.sessions).toHaveLength(2);
    const ids = result.sessions.map((s: any) => s.id);
    expect(ids).toContain(s1.id);
    expect(ids).toContain(s2.id);
  });

  it("each entry has id, goal, outcome, started_at, duration_seconds", async () => {
    const project = seedProject();
    const session = seedSession(project.id);
    updateSessionGoalAndKeywords(session.id as any, "refactor auth", []);

    const result = r(await handleListSessions({ project_id: project.id }));
    const entry = result.sessions[0];

    expect(entry).toHaveProperty("id");
    expect(entry).toHaveProperty("goal");
    expect(entry).toHaveProperty("outcome");
    expect(entry).toHaveProperty("started_at");
    expect(entry).toHaveProperty("duration_seconds");
  });

  it("respects the limit parameter", async () => {
    const project = seedProject();
    seedSession(project.id);
    seedSession(project.id);
    seedSession(project.id);

    const result = r(await handleListSessions({ project_id: project.id, limit: 2 }));
    expect(result.sessions).toHaveLength(2);
  });

});

// ─── end_session ──────────────────────────────────────────────────────────────

describe("handleEndSession", () => {
  it("runs the full Layer 1→2→3 pipeline and stores a digest", async () => {
    const project = seedProject();
    const session = seedSession(project.id);

    // Buffer some messages
    await handleStoreMessage({ session_id: session.id, role: "user", content: "fix the JWT auth bug", index: 0 });
    await handleStoreMessage({ session_id: session.id, role: "assistant", content: "I will refactor the auth module", index: 1 });
    await handleStoreEvent({
      session_id: session.id,
      tool: "bash",
      args: { command: "git commit -m 'fix JWT auth'" },
      result: { output: "abc1234" },
      success: true,
    });

    const result = r(await handleEndSession({
      session_id: session.id,
      project_id: project.id,
      outcome: "completed",
      exit_code: 0,
    }));

    expect(result.ok).toBe(true);

    // Digest should be written
    const digest = getDigestBySession(session.id as any);
    expect(digest).not.toBeNull();
    expect(digest!.outcome).toBe("completed");
  });

  it("updates the project memory_doc after session end", async () => {
    const project = seedProject();
    const session = seedSession(project.id);

    await handleStoreMessage({ session_id: session.id, role: "user", content: "add dark mode", index: 0 });

    await handleEndSession({
      session_id: session.id,
      project_id: project.id,
      outcome: "completed",
      exit_code: 0,
    });

    const updated = getProjectById(project.id);
    expect(updated!.memory_doc).not.toBeNull();
    expect(updated!.memory_doc).toContain("# Project Memory");
  });

  it("handles crashed sessions without throwing", async () => {
    const project = seedProject();
    const session = seedSession(project.id);
    // no messages buffered — crashed before any messages

    const result = r(await handleEndSession({
      session_id: session.id,
      project_id: project.id,
      outcome: "crashed",
      exit_code: 1,
    }));

    expect(result.ok).toBe(true);
  });

  it("returns an error for invalid input without crashing", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await handleEndSession({} as any);
    expect(result).toHaveProperty("error");
  });

  it("creates a missing session with the provided tool name", async () => {
    const project = seedProject();
    const sessionId = "11111111-1111-4111-8111-111111111111";

    await handleStoreMessage({
      session_id: sessionId,
      role: "user",
      content: "review the current workspace state",
      index: 0,
    });

    const result = r(await handleEndSession({
      session_id: sessionId,
      project_id: project.id,
      tool: "codex",
      outcome: "completed",
      exit_code: 0,
    }));

    expect(result.ok).toBe(true);
    expect(getSessionById(sessionId as any)?.tool).toBe("codex");
  });
});
