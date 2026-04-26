import { describe, it, expect } from "vitest";
import { generateDigest } from "../../src/layer2/digest.js";
import type { Layer1Output, ExtractedEvent } from "../../src/types/index.js";

// ─── Factory ──────────────────────────────────────────────────────────────────

function makeLayer1(overrides: Partial<Layer1Output> = {}): Layer1Output {
  return {
    session_id: "sid-1" as any,
    goal: "Implement authentication",
    facts: [],
    weightedMessages: [],
    events: [],
    decisions: [],
    errors: [],
    keywords: ["authentication", "middleware", "session"],
    patterns: [],
    tokenCount: 100,
    ...overrides,
  };
}

function fileEvent(path: string, type: "file_created" | "file_modified"): ExtractedEvent {
  return {
    id: "eid" as any,
    session_id: "sid-1" as any,
    type,
    payload: { type, path, operation: "write_file", diffSummary: null },
    weight: 0.8,
    timestamp: Date.now() as any,
    source: "mcp",
  };
}

function errorEvent(message: string): ExtractedEvent {
  return {
    id: "eid" as any,
    session_id: "sid-1" as any,
    type: "error",
    payload: { type: "error", message, command: null, exitCode: null },
    weight: 0.7,
    timestamp: Date.now() as any,
    source: "mcp",
  };
}

function testRunEvent(command: string, failed = 0): ExtractedEvent {
  return {
    id: "eid" as any,
    session_id: "sid-1" as any,
    type: "test_run",
    payload: { type: "test_run", command, passed: failed > 0 ? 0 : 12, failed, durationMs: null },
    weight: 0.7,
    timestamp: Date.now() as any,
    source: "mcp",
  };
}

// ─── Field mapping ────────────────────────────────────────────────────────────

describe("generateDigest — field mapping", () => {
  it("maps goal from layer1.goal", () => {
    const d = generateDigest(makeLayer1({ goal: "Build login flow" }), "completed", 0);
    expect(d.goal).toBe("Build login flow");
  });

  it("stores a concise task goal instead of a long raw prompt", () => {
    const d = generateDigest(
      makeLayer1({
        goal: "Can you please improve the digest quality mostly focusing on decisions and errors arrays. Here are evaluator notes: summary is garbled and goal is raw.",
      }),
      "completed",
      0
    );
    expect(d.goal).toBe("improve the digest quality mostly focusing on decisions and errors arrays");
    expect(d.goal).not.toContain("Here are evaluator notes");
  });

  it("creates a concise summary from goal, files, and validation", () => {
    const d = generateDigest(
      makeLayer1({
        goal: "Please improve the Layer 3 memory so agents get useful handoff details",
        events: [fileEvent("src/layer3/memory.ts", "file_modified"), testRunEvent("npm run build")],
      }),
      "completed",
      0
    );
    expect(d.summary).toContain("Updated src/layer3/memory.ts");
    expect(d.summary).toContain("Improve Layer 3 project memory quality");
    expect(d.summary).toContain("Validation: npm run build passed");
  });

  it("builds summary with stable decision and issue sentences", () => {
    const d = generateDigest(
      makeLayer1({
        goal: "fix digest quality",
        decisions: ["The architecture uses deterministic Layer 1 extraction before Layer 2 cleanup."],
        errors: ["decisions and errors arrays were empty"],
        events: [fileEvent("src/layer1/combiner.ts", "file_modified")],
      }),
      "completed",
      0
    );
    expect(d.summary).toContain("Goal: Fix digest quality");
    expect(d.summary).toContain("Updated src/layer1/combiner.ts");
    expect(d.summary).toContain("Decision: The architecture uses deterministic Layer 1 extraction before Layer 2 cleanup.");
    expect(d.summary).toContain("Issue: decisions and errors arrays were empty");
  });

  it("falls back to first decision when goal is null", () => {
    const d = generateDigest(
      makeLayer1({ goal: null, decisions: ["Use JWT for auth", "Postgres over SQLite"] }),
      "completed", 0
    );
    expect(d.goal).toBe("Use JWT for auth");
  });

  it("falls back to 'No goal detected' when goal and decisions are both empty", () => {
    const d = generateDigest(makeLayer1({ goal: null, decisions: [] }), "completed", 0);
    expect(d.goal).toBe("No goal detected");
  });

  it("maps decisions from layer1.decisions", () => {
    const d = generateDigest(
      makeLayer1({ decisions: ["Use Postgres", "Add indexes"] }),
      "completed", 0
    );
    expect(d.decisions).toEqual(["Use Postgres", "Add indexes"]);
  });

  it("maps errors_encountered from layer1.errors", () => {
    const d = generateDigest(
      makeLayer1({ errors: ["Build failed", "Test timeout"] }),
      "completed", 0
    );
    expect(d.errors_encountered).toEqual(["Build failed", "Test timeout"]);
  });

  it("maps validation from test events", () => {
    const d = generateDigest(makeLayer1({ events: [testRunEvent("npm test", 2)] }), "completed", 0);
    expect(d.validation).toEqual(["npm test failed"]);
    expect(d.errors_encountered).toEqual([]);
    expect(d.facts.filter((fact) => fact.kind === "issue")).toEqual([]);
  });

  it("maps keywords from layer1.keywords", () => {
    const d = generateDigest(makeLayer1({ keywords: ["auth", "token"] }), "completed", 0);
    expect(d.keywords).toEqual(["auth", "token"]);
  });

  it("passes outcome through", () => {
    expect(generateDigest(makeLayer1(), "completed", 0).outcome).toBe("completed");
    expect(generateDigest(makeLayer1(), "interrupted", null).outcome).toBe("interrupted");
    expect(generateDigest(makeLayer1(), "crashed", null).outcome).toBe("crashed");
  });

  it("session_id matches layer1.session_id", () => {
    const d = generateDigest(makeLayer1({ session_id: "test-session" as any }), "completed", 0);
    expect(d.session_id).toBe("test-session");
  });
});

// ─── files_modified ───────────────────────────────────────────────────────────

describe("generateDigest — files_modified", () => {
  it("collects paths from file_created and file_modified events", () => {
    const layer1 = makeLayer1({
      events: [
        fileEvent("src/auth.ts", "file_created"),
        fileEvent("src/db.ts", "file_modified"),
      ],
    });
    const d = generateDigest(layer1, "completed", 0);
    expect(d.files_modified).toContain("src/auth.ts");
    expect(d.files_modified).toContain("src/db.ts");
  });

  it("deduplicates paths", () => {
    const layer1 = makeLayer1({
      events: [
        fileEvent("src/auth.ts", "file_created"),
        fileEvent("src/auth.ts", "file_modified"),
        fileEvent("src/auth.ts", "file_modified"),
      ],
    });
    const d = generateDigest(layer1, "completed", 0);
    expect(d.files_modified.filter((p) => p === "src/auth.ts")).toHaveLength(1);
  });

  it("ignores non-file events", () => {
    const layer1 = makeLayer1({ events: [errorEvent("build failed")] });
    const d = generateDigest(layer1, "completed", 0);
    expect(d.files_modified).toHaveLength(0);
  });

  it("returns empty array when no events", () => {
    const d = generateDigest(makeLayer1({ events: [] }), "completed", 0);
    expect(d.files_modified).toEqual([]);
  });

  it("deduplication preserves insertion order of first occurrence", () => {
    const layer1 = makeLayer1({
      events: [
        fileEvent("src/a.ts", "file_created"),
        fileEvent("src/b.ts", "file_modified"),
        fileEvent("src/c.ts", "file_created"),
        fileEvent("src/a.ts", "file_modified"), // duplicate — should not re-insert
      ],
    });
    const d = generateDigest(layer1, "completed", 0);
    expect(d.files_modified).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
  });
});

// ─── estimated_tokens ─────────────────────────────────────────────────────────

describe("generateDigest — estimated_tokens", () => {
  it("is a positive number", () => {
    const d = generateDigest(makeLayer1(), "completed", 0);
    expect(d.estimated_tokens).toBeGreaterThan(0);
  });

  it("grows with more content", () => {
    const small = generateDigest(makeLayer1({ decisions: [] }), "completed", 0);
    const large = generateDigest(
      makeLayer1({ decisions: Array.from({ length: 10 }, (_, i) => `Decision ${i}: ${"x".repeat(50)}`) }),
      "completed", 0
    );
    expect(large.estimated_tokens).toBeGreaterThan(small.estimated_tokens);
  });
});

// ─── Token budget enforcement ─────────────────────────────────────────────────

// Helper: build layer1 guaranteed to exceed the 500-token budget.
// 20 decisions × 200 chars each = 4000+ chars → well above 500*4 = 2000 char threshold.
function makeOversizedLayer1(overrides: Partial<Layer1Output> = {}): Layer1Output {
  return makeLayer1({
    decisions: Array.from({ length: 20 }, (_, i) => "d".repeat(200) + ` decision-${i}`),
    errors: Array.from({ length: 20 }, (_, i) => "e".repeat(200) + ` error-${i}`),
    keywords: Array.from({ length: 20 }, (_, i) => `keyword${i}`),
    ...overrides,
  });
}

describe("generateDigest — token budget", () => {
  it("truncates decisions to 5 when over budget", () => {
    const d = generateDigest(makeOversizedLayer1(), "completed", 0);
    // Budget is guaranteed exceeded — no conditional guard
    expect(d.decisions.length).toBeLessThanOrEqual(5);
  });

  it("truncates errors to 3 when over budget", () => {
    const d = generateDigest(makeOversizedLayer1(), "completed", 0);
    expect(d.errors_encountered.length).toBeLessThanOrEqual(3);
  });

  it("truncates keywords to 10 when over budget", () => {
    const d = generateDigest(makeOversizedLayer1(), "completed", 0);
    expect(d.keywords.length).toBeLessThanOrEqual(10);
  });

  it("truncates files_modified to 10 when over budget", () => {
    const events = Array.from({ length: 20 }, (_, i) =>
      fileEvent(`src/file${i}.ts`, "file_created")
    );
    const d = generateDigest(makeOversizedLayer1({ events }), "completed", 0);
    expect(d.files_modified.length).toBeLessThanOrEqual(10);
  });

  it("estimated_tokens reflects actual content size after truncation", () => {
    const d = generateDigest(makeOversizedLayer1(), "completed", 0);
    // Recompute expected tokens from the returned fields (same formula as implementation)
    const draft = {
      goal: d.goal,
      summary: d.summary,
      files_modified: d.files_modified,
      decisions: d.decisions,
      errors_encountered: d.errors_encountered,
      validation: d.validation,
      facts: d.facts,
      keywords: d.keywords,
      outcome: d.outcome,
      estimated_tokens: 0,
    };
    const expected = Math.ceil(JSON.stringify(draft).length / 4);
    expect(d.estimated_tokens).toBe(expected);
  });

  it("truncates goal to 150 chars as last resort when still over budget after first pass", () => {
    // Even after truncating to 5 decisions / 3 errors / 10 keywords, a 2000-char goal
    // will keep estimated_tokens above 500, triggering the second-pass goal truncation.
    const veryLongGoal = "g".repeat(2000);
    const d = generateDigest(
      makeOversizedLayer1({ goal: veryLongGoal }),
      "completed",
      0
    );
    expect(d.goal!.length).toBeLessThanOrEqual(150);
  });
});

// ─── Robustness ───────────────────────────────────────────────────────────────

describe("generateDigest — robustness", () => {
  it("never throws and returns valid digest for minimal layer1", () => {
    const minimal: Layer1Output = {
      session_id: "sid" as any,
      goal: null,
      facts: [],
      weightedMessages: [],
      events: [],
      decisions: [],
      errors: [],
      keywords: [],
      patterns: [],
      tokenCount: 0,
    };
    expect(() => generateDigest(minimal, "crashed", null)).not.toThrow();
    const d = generateDigest(minimal, "crashed", null);
    expect(d.goal).toBe("No goal detected");
    expect(d.files_modified).toEqual([]);
    expect(d.outcome).toBe("crashed");
  });

  it("returns an object with all required fields", () => {
    const d = generateDigest(makeLayer1(), "completed", 0);
    expect(typeof d.id).toBe("string");
    expect(typeof d.session_id).toBe("string");
    expect(typeof d.goal).toBe("string");
    expect(Array.isArray(d.files_modified)).toBe(true);
    expect(Array.isArray(d.decisions)).toBe(true);
    expect(Array.isArray(d.errors_encountered)).toBe(true);
    expect(typeof d.outcome).toBe("string");
    expect(Array.isArray(d.keywords)).toBe(true);
    expect(typeof d.estimated_tokens).toBe("number");
    expect(typeof d.created_at).toBe("number");
  });
});
