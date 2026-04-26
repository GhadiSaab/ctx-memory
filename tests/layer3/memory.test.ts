import { describe, it, expect } from "vitest";
import {
  mergeIntoProjectMemory,
  serializeMemory,
  deserializeMemory,
} from "../../src/layer3/memory.js";
import type { ProjectMemory, Layer2Digest } from "../../src/types/index.js";

// ─── Factories ────────────────────────────────────────────────────────────────

function makeMemory(overrides: Partial<ProjectMemory> = {}): ProjectMemory {
  return {
    project_id: "proj-1" as any,
    memory_doc: "",
    architecture: "",
    how_to_test: [],
    conventions: [],
    known_issues: [],
    recent_work: [],
    updated_at: 0 as any,
    ...overrides,
  };
}

function makeDigest(overrides: Partial<Layer2Digest> = {}): Layer2Digest {
  return {
    id: "d-1" as any,
    session_id: "sid-1" as any,
    goal: "Implement authentication",
    summary: "Implemented authentication",
    files_modified: ["src/auth.ts"],
    decisions: [],
    errors_encountered: [],
    validation: [],
    outcome: "completed",
    keywords: ["authentication", "middleware"],
    estimated_tokens: 100,
    created_at: Date.now() as any,
    ...overrides,
  };
}

// ─── recent_work ─────────────────────────────────────────────────────────────

describe("mergeIntoProjectMemory — recent_work", () => {
  it("prepends a new entry with the digest summary", () => {
    const mem = makeMemory();
    const digest = makeDigest({ goal: "Build login flow", summary: "Built login flow" });
    const result = mergeIntoProjectMemory(mem, digest, "sid-new");
    expect(result.recent_work[0].summary).toBe("Built login flow");
    expect(result.recent_work[0].session_id).toBe("sid-new");
  });

  it("new entry is at index 0 (most recent first)", () => {
    const existing = makeMemory({
      recent_work: [
        { id: "e1" as any, project_id: "proj-1" as any, session_id: "old" as any, summary: "Old work", date: 0 as any },
      ],
    });
    const result = mergeIntoProjectMemory(existing, makeDigest({ summary: "New work" }), "sid-new");
    expect(result.recent_work[0].summary).toBe("New work");
    expect(result.recent_work[1].summary).toBe("Old work");
  });

  it("keeps only last 10 entries, dropping oldest", () => {
    // Existing entries ordered most-recent first (as maintained by prepend invariant).
    // Work 9 is newest of existing, Work 0 is oldest.
    const existing = makeMemory({
      recent_work: Array.from({ length: 10 }, (_, i) => ({
        id: `e${i}` as any,
        project_id: "proj-1" as any,
        session_id: `sid-${i}` as any,
        summary: `Work ${9 - i}`, // index 0 = Work 9 (newest), index 9 = Work 0 (oldest)
        date: (9 - i) as any,
      })),
    });
    const result = mergeIntoProjectMemory(existing, makeDigest({ summary: "Work 10" }), "sid-10");
    expect(result.recent_work).toHaveLength(10);
    expect(result.recent_work[0].summary).toBe("Work 10");
    // The oldest entry ("Work 0") is at the tail and gets dropped by slice(0, 10)
    expect(result.recent_work.find((e) => e.summary === "Work 0")).toBeUndefined();
  });

  it("skips recent_work entry when digest.goal is null", () => {
    const result = mergeIntoProjectMemory(makeMemory(), makeDigest({ goal: null, summary: null }), "sid-1");
    expect(result.recent_work).toHaveLength(0);
  });

  it("skips recent_work entry for a raw prompt with no substantive work", () => {
    const result = mergeIntoProjectMemory(
      makeMemory(),
      makeDigest({
        goal: "what mcps do you have",
        summary: "what mcps do you have",
        files_modified: [],
        decisions: [],
        errors_encountered: [],
        validation: [],
      }),
      "sid-1"
    );
    expect(result.recent_work).toHaveLength(0);
  });

  it("new entry has a date (timestamp > 0)", () => {
    const before = Date.now();
    const result = mergeIntoProjectMemory(makeMemory(), makeDigest(), "sid-1");
    expect(result.recent_work[0].date).toBeGreaterThanOrEqual(before);
  });
});

// ─── known_issues ─────────────────────────────────────────────────────────────

describe("mergeIntoProjectMemory — known_issues", () => {
  it("adds new error as KnownIssue with resolvedAt null", () => {
    const digest = makeDigest({ errors_encountered: ["TypeError: cannot read property"] });
    const result = mergeIntoProjectMemory(makeMemory(), digest, "sid-1");
    expect(result.known_issues).toHaveLength(1);
    expect(result.known_issues[0].description).toBe("TypeError: cannot read property");
    expect(result.known_issues[0].resolved_at).toBeNull();
  });

  it("does not duplicate a similar issue (substring match)", () => {
    const existing = makeMemory({
      known_issues: [
        {
          id: "i1" as any,
          project_id: "proj-1" as any,
          description: "TypeError: cannot read property",
          detected_at: 0 as any,
          resolved_at: null,
          resolved_in_session: null,
        },
      ],
    });
    // error is a substring of existing description
    const digest = makeDigest({ errors_encountered: ["TypeError: cannot read property"] });
    const result = mergeIntoProjectMemory(existing, digest, "sid-2");
    expect(result.known_issues).toHaveLength(1);
  });

  it("adds a new issue when no substring match exists", () => {
    const existing = makeMemory({
      known_issues: [
        {
          id: "i1" as any,
          project_id: "proj-1" as any,
          description: "Build timeout",
          detected_at: 0 as any,
          resolved_at: null,
          resolved_in_session: null,
        },
      ],
    });
    const digest = makeDigest({ errors_encountered: ["Database connection refused"] });
    const result = mergeIntoProjectMemory(existing, digest, "sid-2");
    expect(result.known_issues).toHaveLength(2);
  });

  it("marks matching open issue as resolved when outcome is 'completed' and keyword matches", () => {
    const existing = makeMemory({
      known_issues: [
        {
          id: "i1" as any,
          project_id: "proj-1" as any,
          description: "authentication middleware fails",
          detected_at: 0 as any,
          resolved_at: null,
          resolved_in_session: null,
        },
      ],
    });
    const digest = makeDigest({
      outcome: "completed",
      keywords: ["authentication"],
    });
    const result = mergeIntoProjectMemory(existing, digest, "sid-fix");
    const issue = result.known_issues[0];
    expect(issue.resolved_at).not.toBeNull();
    expect(issue.resolved_in_session).toBe("sid-fix");
  });

  it("marks matching open issue as resolved from digest text when keywords are empty", () => {
    const existing = makeMemory({
      known_issues: [
        {
          id: "i1" as any,
          project_id: "proj-1" as any,
          description: "remove everything related to antigravity for the moment",
          detected_at: 0 as any,
          resolved_at: null,
          resolved_in_session: null,
        },
      ],
    });
    const digest = makeDigest({
      outcome: "completed",
      keywords: [],
      summary: "Removed Antigravity integration from the wrapper, CLI, MCP handler, and tests.",
      files_modified: ["src/wrapper/index.ts", "tests/wrapper/antigravity.test.ts"],
    });
    const result = mergeIntoProjectMemory(existing, digest, "sid-fix");
    expect(result.known_issues[0].resolved_at).not.toBeNull();
    expect(result.known_issues[0].resolved_in_session).toBe("sid-fix");
  });

  it("does not resolve issue when outcome is not 'completed'", () => {
    const existing = makeMemory({
      known_issues: [
        {
          id: "i1" as any,
          project_id: "proj-1" as any,
          description: "authentication failure",
          detected_at: 0 as any,
          resolved_at: null,
          resolved_in_session: null,
        },
      ],
    });
    const digest = makeDigest({ outcome: "interrupted", keywords: ["authentication"] });
    const result = mergeIntoProjectMemory(existing, digest, "sid-1");
    expect(result.known_issues[0].resolved_at).toBeNull();
  });

  it("does not re-resolve an already resolved issue", () => {
    const resolvedAt = 12345 as any;
    const existing = makeMemory({
      known_issues: [
        {
          id: "i1" as any,
          project_id: "proj-1" as any,
          description: "authentication failure",
          detected_at: 0 as any,
          resolved_at: resolvedAt,
          resolved_in_session: "sid-old" as any,
        },
      ],
    });
    const digest = makeDigest({ outcome: "completed", keywords: ["authentication"] });
    const result = mergeIntoProjectMemory(existing, digest, "sid-new");
    expect(result.known_issues[0].resolved_at).toBe(resolvedAt);
    expect(result.known_issues[0].resolved_in_session).toBe("sid-old");
  });
});

// ─── conventions ──────────────────────────────────────────────────────────────

describe("mergeIntoProjectMemory — conventions", () => {
  it("appends new decisions as conventions (non-architecture decisions)", () => {
    // "Add error handling" has no tech/arch signals — goes to conventions
    const digest = makeDigest({ decisions: ["Add error handling everywhere"] });
    const result = mergeIntoProjectMemory(makeMemory(), digest, "sid-1");
    expect(result.conventions).toContain("Add error handling everywhere");
  });

  it("does not duplicate existing conventions (exact match)", () => {
    const existing = makeMemory({ conventions: ["Add error handling everywhere"] });
    const digest = makeDigest({ decisions: ["Add error handling everywhere"] });
    const result = mergeIntoProjectMemory(existing, digest, "sid-1");
    expect(result.conventions.filter((c) => c === "Add error handling everywhere")).toHaveLength(1);
  });

  it("keeps at most 20 conventions, dropping oldest", () => {
    const existing = makeMemory({
      conventions: Array.from({ length: 20 }, (_, i) => `Convention ${i}`),
    });
    const digest = makeDigest({ decisions: ["New convention"] });
    const result = mergeIntoProjectMemory(existing, digest, "sid-1");
    expect(result.conventions).toHaveLength(20);
    expect(result.conventions).toContain("New convention");
  });

  it("preserves existing conventions not in the new digest", () => {
    const existing = makeMemory({ conventions: ["Always write tests first"] });
    // "Keep commits atomic" has no tech/arch signals — goes to conventions
    const digest = makeDigest({ decisions: ["Keep commits atomic"] });
    const result = mergeIntoProjectMemory(existing, digest, "sid-1");
    expect(result.conventions).toContain("Always write tests first");
    expect(result.conventions).toContain("Keep commits atomic");
  });

  it("does not promote transient first-person plans as conventions", () => {
    const digest = makeDigest({ decisions: ["I'll use the MCP tool to store that message."] });
    const result = mergeIntoProjectMemory(makeMemory(), digest, "sid-1");
    expect(result.conventions).not.toContain("I'll use the MCP tool to store that message.");
  });
});

// ─── architecture ─────────────────────────────────────────────────────────────

describe("mergeIntoProjectMemory — architecture", () => {
  it("appends architecture-note decisions (containing 'use', 'with', 'instead', 'switched')", () => {
    const digest = makeDigest({ decisions: ["Use Postgres instead of SQLite"] });
    const result = mergeIntoProjectMemory(makeMemory(), digest, "sid-1");
    expect(result.architecture).toContain("Use Postgres instead of SQLite");
  });

  it("does not append decisions without architecture keywords", () => {
    const digest = makeDigest({ decisions: ["Add error handling"] });
    const result = mergeIntoProjectMemory(makeMemory(), digest, "sid-1");
    expect(result.architecture).not.toContain("Add error handling");
  });

  it("does not duplicate existing architecture notes", () => {
    const existing = makeMemory({ architecture: "Use Postgres instead of SQLite" });
    const digest = makeDigest({ decisions: ["Use Postgres instead of SQLite"] });
    const result = mergeIntoProjectMemory(existing, digest, "sid-1");
    const occurrences = result.architecture
      .split("\n")
      .filter((l) => l.includes("Use Postgres instead of SQLite")).length;
    expect(occurrences).toBe(1);
  });

  it("appends multiple architecture notes newline-separated", () => {
    const digest = makeDigest({
      decisions: ["Use Redis with sessions", "Switched from REST to GraphQL"],
    });
    const result = mergeIntoProjectMemory(makeMemory(), digest, "sid-1");
    const lines = result.architecture.split("\n").filter(Boolean);
    expect(lines).toContain("Use Redis with sessions");
    expect(lines).toContain("Switched from REST to GraphQL");
  });

  it("is case-insensitive for architecture keyword detection", () => {
    const digest = makeDigest({ decisions: ["SWITCHED to using bun instead of node"] });
    const result = mergeIntoProjectMemory(makeMemory(), digest, "sid-1");
    expect(result.architecture).toContain("SWITCHED to using bun instead of node");
  });

  it("rejects transient first-person architecture-looking text", () => {
    const digest = makeDigest({ decisions: ["I'll use the MCP tool to store that message."] });
    const result = mergeIntoProjectMemory(makeMemory(), digest, "sid-1");
    expect(result.architecture).not.toContain("I'll use the MCP tool to store that message.");
  });
});

// ─── how_to_test ──────────────────────────────────────────────────────────────

describe("mergeIntoProjectMemory — how_to_test", () => {
  it("records validation commands from digest validation notes", () => {
    const digest = makeDigest({ validation: ["npm run build passed", "npm test failed"] });
    const result = mergeIntoProjectMemory(makeMemory(), digest, "sid-1");
    expect(result.how_to_test).toContain("npm run build");
    expect(result.how_to_test).toContain("npm test");
  });

  it("deduplicates validation commands", () => {
    const existing = makeMemory({ how_to_test: ["npm run build"] });
    const digest = makeDigest({ validation: ["npm run build passed"] });
    const result = mergeIntoProjectMemory(existing, digest, "sid-1");
    expect(result.how_to_test.filter((command) => command === "npm run build")).toHaveLength(1);
  });
});

// ─── updatedAt ───────────────────────────────────────────────────────────────

describe("mergeIntoProjectMemory — updatedAt", () => {
  it("sets updated_at to current time", () => {
    const before = Date.now();
    const result = mergeIntoProjectMemory(makeMemory(), makeDigest(), "sid-1");
    expect(result.updated_at).toBeGreaterThanOrEqual(before);
  });
});

// ─── memory_doc ──────────────────────────────────────────────────────────────

describe("mergeIntoProjectMemory — memory_doc", () => {
  it("sets memory_doc to serialized markdown", () => {
    const digest = makeDigest({ goal: "Build auth", summary: "Built auth" });
    const result = mergeIntoProjectMemory(makeMemory(), digest, "sid-1");
    expect(result.memory_doc).toContain("# Project Memory");
    expect(result.memory_doc).toContain("Built auth");
  });
});

// ─── serializeMemory ──────────────────────────────────────────────────────────

describe("serializeMemory", () => {
  it("produces a string containing all section headers", () => {
    const s = serializeMemory(makeMemory());
    expect(s).toContain("## Architecture");
    expect(s).toContain("## How to Test");
    expect(s).toContain("## Known Issues");
    expect(s).toContain("## Conventions");
    expect(s).toContain("## Recent Work");
  });

  it("renders open known issues with [ ]", () => {
    const mem = makeMemory({
      known_issues: [
        {
          id: "i1" as any,
          project_id: "proj-1" as any,
          description: "Build fails on CI",
          detected_at: 0 as any,
          resolved_at: null,
          resolved_in_session: null,
        },
      ],
    });
    expect(serializeMemory(mem)).toContain("- [ ] Build fails on CI");
  });

  it("renders resolved known issues with [x]", () => {
    const mem = makeMemory({
      known_issues: [
        {
          id: "i1" as any,
          project_id: "proj-1" as any,
          description: "Login bug",
          detected_at: 0 as any,
          resolved_at: 999 as any,
          resolved_in_session: "sid-fix" as any,
        },
      ],
    });
    expect(serializeMemory(mem)).toContain("- [x] Login bug");
  });

  it("renders conventions as bullet list", () => {
    const mem = makeMemory({ conventions: ["Use TypeScript", "Prefer functional style"] });
    const s = serializeMemory(mem);
    expect(s).toContain("- Use TypeScript");
    expect(s).toContain("- Prefer functional style");
  });

  it("renders how_to_test as bullet list", () => {
    const mem = makeMemory({ how_to_test: ["npm run build", "npm test"] });
    const s = serializeMemory(mem);
    expect(s).toContain("- npm run build");
    expect(s).toContain("- npm test");
  });

  it("renders recent work with date prefix", () => {
    const mem = makeMemory({
      recent_work: [
        {
          id: "r1" as any,
          project_id: "proj-1" as any,
          session_id: "sid-1" as any,
          summary: "Implement login flow",
          date: new Date("2025-01-15").getTime() as any,
        },
      ],
    });
    expect(serializeMemory(mem)).toContain("[2025-01-15] Implement login flow");
  });

  it("renders architecture lines as bullets", () => {
    const mem = makeMemory({ architecture: "Use Postgres\nSwitched to Redis" });
    const s = serializeMemory(mem);
    expect(s).toContain("- Use Postgres");
    expect(s).toContain("- Switched to Redis");
  });

  it("shows placeholder text when sections are empty", () => {
    const s = serializeMemory(makeMemory());
    expect(s).toContain("_No architecture notes yet._");
    expect(s).toContain("_No test commands recorded yet._");
    expect(s).toContain("_No known issues._");
    expect(s).toContain("_No conventions recorded yet._");
    expect(s).toContain("_No recent work._");
  });
});

// ─── deserializeMemory ────────────────────────────────────────────────────────

describe("deserializeMemory", () => {
  it("round-trips through serialize → deserialize for architecture", () => {
    const mem = makeMemory({ architecture: "Use Postgres\nSwitched to Redis" });
    const doc = serializeMemory(mem);
    const restored = deserializeMemory(doc, "proj-1");
    expect(restored.architecture).toContain("Use Postgres");
    expect(restored.architecture).toContain("Switched to Redis");
  });

  it("round-trips conventions", () => {
    const mem = makeMemory({ conventions: ["Use TypeScript", "Prefer functional style"] });
    const doc = serializeMemory(mem);
    const restored = deserializeMemory(doc, "proj-1");
    expect(restored.conventions).toContain("Use TypeScript");
    expect(restored.conventions).toContain("Prefer functional style");
  });

  it("round-trips how_to_test", () => {
    const mem = makeMemory({ how_to_test: ["npm run build", "npm test"] });
    const doc = serializeMemory(mem);
    const restored = deserializeMemory(doc, "proj-1");
    expect(restored.how_to_test).toContain("npm run build");
    expect(restored.how_to_test).toContain("npm test");
  });

  it("round-trips known issues — open and resolved", () => {
    const mem = makeMemory({
      known_issues: [
        {
          id: "i1" as any, project_id: "proj-1" as any,
          description: "Build fails", detected_at: 0 as any, resolved_at: null, resolved_in_session: null,
        },
        {
          id: "i2" as any, project_id: "proj-1" as any,
          description: "Login bug", detected_at: 0 as any, resolved_at: 1 as any, resolved_in_session: "sid" as any,
        },
      ],
    });
    const doc = serializeMemory(mem);
    const restored = deserializeMemory(doc, "proj-1");
    const open = restored.known_issues.find((i) => i.description === "Build fails");
    const resolved = restored.known_issues.find((i) => i.description === "Login bug");
    expect(open?.resolved_at).toBeNull();
    expect(resolved?.resolved_at).not.toBeNull();
  });

  it("round-trips recent work summaries", () => {
    const mem = makeMemory({
      recent_work: [
        {
          id: "r1" as any, project_id: "proj-1" as any, session_id: "sid" as any,
          summary: "Implement login flow",
          date: new Date("2025-06-01").getTime() as any,
        },
      ],
    });
    const doc = serializeMemory(mem);
    const restored = deserializeMemory(doc, "proj-1");
    expect(restored.recent_work[0].summary).toBe("Implement login flow");
  });

  it("returns empty arrays for empty sections", () => {
    const doc = serializeMemory(makeMemory());
    const restored = deserializeMemory(doc, "proj-1");
    expect(restored.conventions).toEqual([]);
    expect(restored.how_to_test).toEqual([]);
    expect(restored.known_issues).toEqual([]);
    expect(restored.recent_work).toEqual([]);
    expect(restored.architecture).toBe("");
  });

  it("sets project_id from parameter", () => {
    const doc = serializeMemory(makeMemory());
    const restored = deserializeMemory(doc, "my-project");
    expect(restored.project_id).toBe("my-project");
  });
});
