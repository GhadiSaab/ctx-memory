import { describe, it, expect, beforeEach } from "vitest";
import {
  writeDigest,
  getDigestBySession,
  getRecentDigestsByProject,
} from "../../src/db/index.js";
import { clearDb, seedProject, seedSession } from "./helpers.js";

beforeEach(clearDb);

describe("writeDigest", () => {
  it("stores a digest and returns it with all fields deserialized", () => {
    const project = seedProject();
    const session = seedSession(project.id);

    const digest = writeDigest({
      session_id: session.id,
      goal: "Refactor auth module",
      files_modified: ["src/auth.ts", "src/session.ts"],
      decisions: ["Use JWT", "Drop bcrypt"],
      errors_encountered: ["TypeError: cannot read property"],
      outcome: "completed",
      keywords: ["auth", "jwt", "refactor"],
      estimated_tokens: 320,
    });

    expect(digest.id).toBeTypeOf("string");
    expect(digest.session_id).toBe(session.id);
    expect(digest.goal).toBe("Refactor auth module");
    expect(digest.files_modified).toEqual(["src/auth.ts", "src/session.ts"]);
    expect(digest.decisions).toEqual(["Use JWT", "Drop bcrypt"]);
    expect(digest.errors_encountered).toEqual(["TypeError: cannot read property"]);
    expect(digest.outcome).toBe("completed");
    expect(digest.keywords).toEqual(["auth", "jwt", "refactor"]);
    expect(digest.estimated_tokens).toBe(320);
    expect(digest.created_at).toBeGreaterThan(0);
  });

  it("handles null goal and empty arrays correctly", () => {
    const project = seedProject();
    const session = seedSession(project.id);

    const digest = writeDigest({
      session_id: session.id,
      goal: null,
      files_modified: [],
      decisions: [],
      errors_encountered: [],
      outcome: null,
      keywords: [],
      estimated_tokens: 10,
    });

    expect(digest.goal).toBeNull();
    expect(digest.outcome).toBeNull();
    expect(digest.files_modified).toEqual([]);
    expect(digest.decisions).toEqual([]);
    expect(digest.errors_encountered).toEqual([]);
    expect(digest.keywords).toEqual([]);
  });

  it("rejects a second digest for the same session (UNIQUE constraint)", () => {
    const project = seedProject();
    const session = seedSession(project.id);

    writeDigest({
      session_id: session.id,
      goal: "first",
      files_modified: [],
      decisions: [],
      errors_encountered: [],
      outcome: "completed",
      keywords: [],
      estimated_tokens: 50,
    });

    expect(() =>
      writeDigest({
        session_id: session.id,
        goal: "second",
        files_modified: [],
        decisions: [],
        errors_encountered: [],
        outcome: "completed",
        keywords: [],
        estimated_tokens: 50,
      })
    ).toThrow();
  });
});

describe("getDigestBySession", () => {
  it("reads back what was written", () => {
    const project = seedProject();
    const session = seedSession(project.id);

    const written = writeDigest({
      session_id: session.id,
      goal: "Do something",
      files_modified: ["a.ts"],
      decisions: ["decided"],
      errors_encountered: [],
      outcome: "interrupted",
      keywords: ["k1"],
      estimated_tokens: 100,
    });

    const read = getDigestBySession(session.id);
    expect(read).not.toBeNull();
    expect(read!.id).toBe(written.id);
    expect(read!.goal).toBe("Do something");
    expect(read!.files_modified).toEqual(["a.ts"]);
    expect(read!.decisions).toEqual(["decided"]);
    expect(read!.outcome).toBe("interrupted");
  });

  it("returns null for a session without a digest", () => {
    const project = seedProject();
    const session = seedSession(project.id);
    expect(getDigestBySession(session.id)).toBeNull();
  });
});

describe("getRecentDigestsByProject", () => {
  it("returns digests ordered by created_at DESC, limited to requested count", () => {
    const project = seedProject();

    const sessions = [
      seedSession(project.id),
      seedSession(project.id),
      seedSession(project.id),
    ];

    // Write digests in order; created_at will be >= the previous one
    for (const s of sessions) {
      writeDigest({
        session_id: s.id,
        goal: `goal for ${s.id}`,
        files_modified: [],
        decisions: [],
        errors_encountered: [],
        outcome: "completed",
        keywords: [],
        estimated_tokens: 50,
      });
    }

    const recent = getRecentDigestsByProject(project.id, 2);
    expect(recent).toHaveLength(2);
    // Most recent first
    expect(recent[0].created_at).toBeGreaterThanOrEqual(recent[1].created_at);
  });

  it("only returns digests for the requested project", () => {
    const p1 = seedProject({ path_hash: "ph1" });
    const p2 = seedProject({ path_hash: "ph2" });

    const s1 = seedSession(p1.id);
    const s2 = seedSession(p2.id);

    writeDigest({ session_id: s1.id, goal: "p1", files_modified: [], decisions: [], errors_encountered: [], outcome: null, keywords: [], estimated_tokens: 10 });
    writeDigest({ session_id: s2.id, goal: "p2", files_modified: [], decisions: [], errors_encountered: [], outcome: null, keywords: [], estimated_tokens: 10 });

    const p1Digests = getRecentDigestsByProject(p1.id, 10);
    expect(p1Digests).toHaveLength(1);
    expect(p1Digests[0].goal).toBe("p1");
  });
});
