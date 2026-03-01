import { describe, it, expect, beforeEach } from "vitest";
import { db } from "../../src/db/connection.js";
import {
  createSession,
  getSessionById,
  heartbeat,
  closeSession,
  sweepOrphanedSessions,
  updateSessionGoalAndKeywords,
} from "../../src/db/index.js";
import { clearDb, seedProject } from "./helpers.js";

beforeEach(clearDb);

describe("createSession", () => {
  it("creates a session with correct defaults", () => {
    const project = seedProject();
    const session = createSession({ project_id: project.id, tool: "claude-code" });

    expect(session.id).toBeTypeOf("string");
    expect(session.project_id).toBe(project.id);
    expect(session.tool).toBe("claude-code");
    expect(session.outcome).toBeNull();
    expect(session.ended_at).toBeNull();
    expect(session.keywords).toEqual([]);
    expect(session.embedding).toBeNull();
    expect(session.message_count).toBe(0);
    expect(session.started_at).toBeGreaterThan(0);
    expect(session.last_seen_at).toBe(session.started_at);
  });
});

describe("heartbeat", () => {
  it("updates last_seen_at to a newer timestamp", async () => {
    const project = seedProject();
    const session = createSession({ project_id: project.id, tool: "claude-code" });
    const before = session.last_seen_at;

    // Advance the clock manually in the DB to simulate time passing
    await new Promise((r) => setTimeout(r, 5));
    heartbeat(session.id);

    const updated = getSessionById(session.id)!;
    expect(updated.last_seen_at).toBeGreaterThan(before);
  });
});

describe("closeSession", () => {
  it("sets outcome, exit_code, ended_at, and duration_seconds", () => {
    const project = seedProject();
    const session = createSession({ project_id: project.id, tool: "codex" });

    closeSession(session.id, "completed", 0);

    const closed = getSessionById(session.id)!;
    expect(closed.outcome).toBe("completed");
    expect(closed.exit_code).toBe(0);
    expect(closed.ended_at).not.toBeNull();
    expect(closed.ended_at!).toBeGreaterThanOrEqual(session.started_at);
    expect(closed.duration_seconds).toBeGreaterThanOrEqual(0);
  });

  it("accepts null exit_code for interrupted sessions", () => {
    const project = seedProject();
    const session = createSession({ project_id: project.id, tool: "gemini" });

    closeSession(session.id, "interrupted", null);

    const closed = getSessionById(session.id)!;
    expect(closed.outcome).toBe("interrupted");
    expect(closed.exit_code).toBeNull();
  });
});

describe("updateSessionGoalAndKeywords", () => {
  it("persists goal and deserializes keywords array", () => {
    const project = seedProject();
    const session = createSession({ project_id: project.id, tool: "claude-code" });

    updateSessionGoalAndKeywords(session.id, "Fix the auth bug", ["auth", "jwt", "bug"]);

    const updated = getSessionById(session.id)!;
    expect(updated.goal).toBe("Fix the auth bug");
    expect(updated.keywords).toEqual(["auth", "jwt", "bug"]);
  });

  it("accepts null goal", () => {
    const project = seedProject();
    const session = createSession({ project_id: project.id, tool: "claude-code" });

    updateSessionGoalAndKeywords(session.id, null, []);

    expect(getSessionById(session.id)!.goal).toBeNull();
  });
});

describe("sweepOrphanedSessions", () => {
  it("closes sessions whose last_seen_at is beyond the timeout", () => {
    const project = seedProject();
    const stale = createSession({ project_id: project.id, tool: "claude-code" });

    // Back-date last_seen_at to 2 hours ago
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    db.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?").run(twoHoursAgo, stale.id);

    const swept = sweepOrphanedSessions(60); // 60-minute timeout

    expect(swept).toContain(stale.id);
    const closed = getSessionById(stale.id)!;
    expect(closed.outcome).toBe("crashed");
    expect(closed.ended_at).not.toBeNull();
  });

  it("ignores sessions that are still within the timeout window", () => {
    const project = seedProject();
    const active = createSession({ project_id: project.id, tool: "claude-code" });
    // last_seen_at is just now — well within a 60-minute timeout

    const swept = sweepOrphanedSessions(60);

    expect(swept).not.toContain(active.id);
    expect(getSessionById(active.id)!.outcome).toBeNull();
  });

  it("ignores already-closed sessions", () => {
    const project = seedProject();
    const session = createSession({ project_id: project.id, tool: "claude-code" });

    closeSession(session.id, "completed", 0);
    // Back-date last_seen_at — but outcome is already set, so sweep should skip it
    db.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?").run(0, session.id);

    const swept = sweepOrphanedSessions(60);
    expect(swept).not.toContain(session.id);
    // outcome must remain "completed", not get overwritten to "crashed"
    expect(getSessionById(session.id)!.outcome).toBe("completed");
  });

  it("returns multiple swept IDs when several sessions are stale", () => {
    const project = seedProject();
    const s1 = createSession({ project_id: project.id, tool: "claude-code" });
    const s2 = createSession({ project_id: project.id, tool: "codex" });
    const active = createSession({ project_id: project.id, tool: "gemini" });

    const staleTime = Date.now() - 2 * 60 * 60 * 1000;
    db.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?").run(staleTime, s1.id);
    db.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?").run(staleTime, s2.id);

    const swept = sweepOrphanedSessions(60);

    expect(swept).toHaveLength(2);
    expect(swept).toContain(s1.id);
    expect(swept).toContain(s2.id);
    expect(swept).not.toContain(active.id);
  });
});
