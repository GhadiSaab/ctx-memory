import { describe, it, expect, beforeEach } from "vitest";
import {
  batchInsertEvents,
  getEventsBySession,
  getEventsBySessionAndType,
  insertEvent,
} from "../../src/db/index.js";
import { clearDb, seedProject, seedSession } from "./helpers.js";
import type { DecisionPayload, ErrorPayload, FileModifiedPayload } from "../../src/types/index.js";

beforeEach(clearDb);

describe("insertEvent", () => {
  it("stores and returns the event with the correct payload", () => {
    const project = seedProject();
    const session = seedSession(project.id);

    const payload: DecisionPayload = {
      type: "decision",
      summary: "Use SQLite over Postgres",
      rationale: "Simpler deployment",
    };

    const event = insertEvent({
      session_id: session.id,
      type: "decision",
      payload,
      weight: 0.8,
      source: "hook",
    });

    expect(event.id).toBeTypeOf("string");
    expect(event.session_id).toBe(session.id);
    expect(event.type).toBe("decision");
    expect(event.weight).toBe(0.8);
    expect(event.source).toBe("hook");
    expect(event.payload).toEqual(payload);
    expect(event.timestamp).toBeGreaterThan(0);
  });

  it("defaults weight to 0.5 when not provided", () => {
    const project = seedProject();
    const session = seedSession(project.id);

    const event = insertEvent({
      session_id: session.id,
      type: "fact",
      payload: { type: "fact", content: "Node.js is used", confidence: 0.9 },
      source: "mcp",
    });

    expect(event.weight).toBe(0.5);
  });
});

describe("batchInsertEvents", () => {
  it("inserts all events atomically and returns them in input order", () => {
    const project = seedProject();
    const session = seedSession(project.id);

    const filePayload: FileModifiedPayload = {
      type: "file_modified",
      path: "/src/index.ts",
      changeType: "modified",
    };
    const errorPayload: ErrorPayload = {
      type: "error",
      message: "Cannot find module",
      errorType: "ModuleNotFoundError",
    };
    const decisionPayload: DecisionPayload = {
      type: "decision",
      summary: "Switched to ESM",
    };

    const inserted = batchInsertEvents([
      { session_id: session.id, type: "file_modified", payload: filePayload, source: "hook" },
      { session_id: session.id, type: "error", payload: errorPayload, source: "hook", weight: 0.9 },
      { session_id: session.id, type: "decision", payload: decisionPayload, source: "mcp" },
    ]);

    expect(inserted).toHaveLength(3);
    expect(inserted[0].type).toBe("file_modified");
    expect(inserted[1].type).toBe("error");
    expect(inserted[1].weight).toBe(0.9);
    expect(inserted[2].type).toBe("decision");

    // All have distinct IDs
    const ids = inserted.map((e) => e.id);
    expect(new Set(ids).size).toBe(3);
  });

  it("rolls back entirely if one event is invalid", () => {
    const project = seedProject();
    const session = seedSession(project.id);

    // FK violation: non-existent session_id in the second event
    const fakeSessionId = "00000000-0000-0000-0000-000000000000" as any;
    expect(() =>
      batchInsertEvents([
        {
          session_id: session.id,
          type: "fact",
          payload: { type: "fact", content: "ok", confidence: 1 },
          source: "mcp",
        },
        {
          session_id: fakeSessionId,
          type: "fact",
          payload: { type: "fact", content: "bad", confidence: 1 },
          source: "mcp",
        },
      ])
    ).toThrow();

    // The first valid event must also be rolled back
    expect(getEventsBySession(session.id)).toHaveLength(0);
  });
});

describe("getEventsBySession", () => {
  it("returns events ordered by timestamp ASC", () => {
    const project = seedProject();
    const session = seedSession(project.id);

    batchInsertEvents([
      { session_id: session.id, type: "goal_set", payload: { type: "goal_set", goal: "first" }, source: "hook" },
      { session_id: session.id, type: "goal_set", payload: { type: "goal_set", goal: "second" }, source: "hook" },
      { session_id: session.id, type: "goal_set", payload: { type: "goal_set", goal: "third" }, source: "hook" },
    ]);

    const events = getEventsBySession(session.id);
    expect(events).toHaveLength(3);
    // timestamps are non-decreasing
    for (let i = 1; i < events.length; i++) {
      expect(events[i].timestamp).toBeGreaterThanOrEqual(events[i - 1].timestamp);
    }
  });

  it("returns empty array for a session with no events", () => {
    const project = seedProject();
    const session = seedSession(project.id);
    expect(getEventsBySession(session.id)).toEqual([]);
  });
});

describe("getEventsBySessionAndType", () => {
  it("filters to only the requested event type", () => {
    const project = seedProject();
    const session = seedSession(project.id);

    batchInsertEvents([
      { session_id: session.id, type: "decision", payload: { type: "decision", summary: "use SQLite" }, source: "hook" },
      { session_id: session.id, type: "error", payload: { type: "error", message: "oops" }, source: "hook" },
      { session_id: session.id, type: "decision", payload: { type: "decision", summary: "use ESM" }, source: "hook" },
    ]);

    const decisions = getEventsBySessionAndType(session.id, "decision");
    expect(decisions).toHaveLength(2);
    expect(decisions.every((e) => e.type === "decision")).toBe(true);
  });
});
