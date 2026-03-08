import { describe, it, expect } from "vitest";
import { detectPatterns } from "../../src/layer1/patterns.js";
import type { WeightedMessage, StructuralFeatures } from "../../src/types/index.js";

// ─── Factory ──────────────────────────────────────────────────────────────────

function makeFeatures(overrides: Partial<StructuralFeatures> = {}): StructuralFeatures {
  return {
    length: 100,
    hasCodeBlock: false,
    hasFilePath: false,
    hasUrl: false,
    hasError: false,
    hasDecisionPhrase: false,
    hasGoalPhrase: false,
    questionCount: 0,
    imperativeCount: 0,
    sentenceCount: 1,
    startsWithVerb: false,
    isShortConfirmation: false,
    positionalWeight: 0.4,
    ...overrides,
  };
}

function wm(
  role: "user" | "assistant",
  content: string,
  weight: number,
  type: "decision" | "goal" | "error" | "conclusion" | "noise" = "noise",
  featuresOverrides: Partial<StructuralFeatures> = {}
): WeightedMessage {
  return {
    message: {
      id: "id" as any,
      session_id: "sid" as any,
      role,
      content,
      index: 0,
      timestamp: 0 as any,
    },
    weight,
    type,
    features: makeFeatures({ length: content.length, ...featuresOverrides }),
  };
}

// ─── No patterns ──────────────────────────────────────────────────────────────

describe("detectPatterns", () => {
  it("returns empty array for empty input", () => {
    expect(detectPatterns([])).toEqual([]);
  });

  it("returns empty array when no patterns are present", () => {
    const messages = [
      wm("user", "Hello, can you help?", 0.4),
      wm("assistant", "Sure.", 0.3),
      wm("user", "Thanks.", 0.3),
    ];
    expect(detectPatterns(messages)).toEqual([]);
  });
});

// ─── confirmation ─────────────────────────────────────────────────────────────

describe("confirmation pattern", () => {
  it("detects assistant proposal immediately followed by user short-confirmation", () => {
    // Content must contain a decision signal for extractedDecision to be non-null
    const proposal = "I'll use React with TypeScript. " + "x".repeat(170); // length > 200, has decision signal
    const messages = [
      wm("assistant", proposal, 0.7),                            // weight > 0.6, length > 200
      wm("user", "yes", 0.3, "noise", { isShortConfirmation: true }),
    ];

    const patterns = detectPatterns(messages);
    expect(patterns).toHaveLength(1);
    expect(patterns[0].type).toBe("confirmation");
    expect(patterns[0].messageIndexes).toEqual([0, 1]);
    expect(patterns[0].confidence).toBe(1.0);
    expect(patterns[0].extractedDecision).not.toBeNull();
  });

  it("does not fire when assistant weight is too low", () => {
    const proposal = "x".repeat(201);
    const messages = [
      wm("assistant", proposal, 0.5),   // weight <= 0.6, should not trigger
      wm("user", "yes", 0.3, "noise", { isShortConfirmation: true }),
    ];
    expect(detectPatterns(messages)).toHaveLength(0);
  });

  it("does not fire when assistant message is too short", () => {
    const messages = [
      wm("assistant", "Short reply.", 0.8),   // length < 200
      wm("user", "yes", 0.3, "noise", { isShortConfirmation: true }),
    ];
    expect(detectPatterns(messages)).toHaveLength(0);
  });

  it("does not fire when user response is not a short confirmation", () => {
    const proposal = "x".repeat(201);
    const messages = [
      wm("assistant", proposal, 0.8),
      wm("user", "Actually, let me think about that differently.", 0.5),
    ];
    expect(detectPatterns(messages)).toHaveLength(0);
  });

  it("extractedDecision is at most 120 chars when content is longer than 120 chars", () => {
    // Decision sentence is capped at 120 chars
    const proposal = "I'll use React with TypeScript for the frontend. " + "x".repeat(200);
    const messages = [
      wm("assistant", proposal, 0.8),
      wm("user", "perfect", 0.3, "noise", { isShortConfirmation: true }),
    ];
    const [p] = detectPatterns(messages);
    expect(p).toBeDefined();
    expect(p.extractedDecision).not.toBeNull();
    expect(p.extractedDecision!.length).toBeLessThanOrEqual(120);
  });
});

// ─── error_retry ──────────────────────────────────────────────────────────────

describe("error_retry pattern", () => {
  it("detects error immediately followed by conclusion", () => {
    const messages = [
      wm("user", "Run the build.", 0.5, "error"),
      wm("assistant", "Fixed it — build passes now.", 0.7, "conclusion"),
    ];
    const patterns = detectPatterns(messages);
    expect(patterns).toHaveLength(1);
    expect(patterns[0].type).toBe("error_retry");
    expect(patterns[0].messageIndexes).toContain(0);
    expect(patterns[0].messageIndexes).toContain(1);
    expect(patterns[0].confidence).toBe(1.0);
    expect(patterns[0].summary).toMatch(/tried/i);
    expect(patterns[0].summary).toMatch(/resolved/i);
  });

  it("detects error followed by high-weight assistant within 3 messages", () => {
    const messages = [
      wm("user", "Error: module not found", 0.6, "error"),
      wm("assistant", "Let me check.", 0.3),
      wm("user", "Still failing.", 0.4),
      wm("assistant", "Try this approach instead.", 0.8),
    ];
    const patterns = detectPatterns(messages);
    expect(patterns.some((p) => p.type === "error_retry")).toBe(true);
    const p = patterns.find((p) => p.type === "error_retry")!;
    expect(p.confidence).toBe(0.7); // distance > 1
  });

  it("confidence is 0.7 when resolution is more than 1 message away", () => {
    const messages = [
      wm("user", "crash", 0.5, "error"),
      wm("assistant", "looking...", 0.2),
      wm("assistant", "Found it. Done.", 0.8, "conclusion"),
    ];
    const p = detectPatterns(messages).find((p) => p.type === "error_retry");
    expect(p?.confidence).toBe(0.7);
  });

  it("does not fire when no resolution appears within 3 messages", () => {
    const messages = [
      wm("user", "crashed", 0.5, "error"),
      wm("assistant", "hmm", 0.2),
      wm("user", "still broken", 0.4),
      wm("assistant", "still looking", 0.2),
      wm("user", "any progress?", 0.3),
    ];
    const patterns = detectPatterns(messages);
    expect(patterns.some((p) => p.type === "error_retry")).toBe(false);
  });

  it("does not fire when resolution appears at distance 4 (boundary: window is i+1 to i+3)", () => {
    // j <= Math.min(i + 3, ...) — i+4 is outside the window
    const messages = [
      wm("user", "crashed", 0.5, "error"),
      wm("assistant", "checking", 0.2),
      wm("user", "still broken", 0.4),
      wm("assistant", "still looking", 0.2),
      wm("assistant", "Found the fix.", 0.8, "conclusion"), // distance 4 — out of range
    ];
    expect(detectPatterns(messages).some((p) => p.type === "error_retry")).toBe(false);
  });
});

// ─── iteration ────────────────────────────────────────────────────────────────

describe("iteration pattern", () => {
  it("detects 3+ consecutive high-weight messages referencing the same file", () => {
    const path = "./src/auth.ts";
    const messages = [
      wm("assistant", `Edit ${path} to fix the import`, 0.7),
      wm("user", `Updated ${path}, still failing`, 0.6),
      wm("assistant", `Let's refactor ${path} again`, 0.8),
    ];
    const patterns = detectPatterns(messages);
    expect(patterns.some((p) => p.type === "iteration")).toBe(true);
    const p = patterns.find((p) => p.type === "iteration")!;
    expect(p.messageIndexes).toHaveLength(3);
    expect(p.summary).toContain(path);
  });

  it("does not fire for only 2 consecutive file references", () => {
    const path = "./src/db.ts";
    const messages = [
      wm("assistant", `Edit ${path}`, 0.7),
      wm("user", `Updated ${path}`, 0.6),
      wm("assistant", "Now try running the tests.", 0.5),
    ];
    expect(detectPatterns(messages).some((p) => p.type === "iteration")).toBe(false);
  });

  it("does not fire when messages have low weight", () => {
    const path = "./src/index.ts";
    const messages = [
      wm("assistant", `Edit ${path}`, 0.3),
      wm("user", `Changed ${path}`, 0.2),
      wm("assistant", `Revisit ${path}`, 0.1),
    ];
    expect(detectPatterns(messages).some((p) => p.type === "iteration")).toBe(false);
  });

  it("includes messages with weight exactly 0.5 in the iteration run (>= 0.5 qualifies)", () => {
    const path = "./src/auth.ts";
    const messages = [
      wm("assistant", `Edit ${path}`, 0.5),
      wm("user", `Updated ${path}`, 0.5),
      wm("assistant", `Revisit ${path}`, 0.5),
    ];
    expect(detectPatterns(messages).some((p) => p.type === "iteration")).toBe(true);
  });

  it("breaks the run when a message has weight 0.49 (< 0.5 does not qualify)", () => {
    const path = "./src/auth.ts";
    const messages = [
      wm("assistant", `Edit ${path}`, 0.5),
      wm("user", `Updated ${path}`, 0.49), // breaks the run
      wm("assistant", `Revisit ${path}`, 0.5),
    ];
    expect(detectPatterns(messages).some((p) => p.type === "iteration")).toBe(false);
  });

  it("breaks the run when a non-matching message interrupts", () => {
    const path = "./src/utils.ts";
    const messages = [
      wm("assistant", `Edit ${path}`, 0.7),
      wm("user", "Something unrelated", 0.6),  // no file path → breaks run
      wm("assistant", `Revisit ${path}`, 0.8),
      wm("user", `Updated ${path}`, 0.7),
    ];
    expect(detectPatterns(messages).some((p) => p.type === "iteration")).toBe(false);
  });
});

// ─── struggle ─────────────────────────────────────────────────────────────────

describe("struggle pattern", () => {
  it("detects 3+ similar-length user messages with low-weight assistant in between", () => {
    const messages = [
      wm("user", "Please fix the login issue.", 0.5),
      wm("assistant", "Ok.", 0.2),                     // low weight
      wm("user", "It still does not work here.", 0.5),
      wm("assistant", "Hmm.", 0.2),                    // low weight
      wm("user", "Can you try again please?", 0.5),
    ];
    const patterns = detectPatterns(messages);
    expect(patterns.some((p) => p.type === "struggle")).toBe(true);
    const p = patterns.find((p) => p.type === "struggle")!;
    expect(p.summary).toMatch(/not making progress/i);
  });

  it("does not fire with only 2 user messages", () => {
    const messages = [
      wm("user", "Fix the login.", 0.5),
      wm("assistant", "Ok.", 0.2),
      wm("user", "Still broken.", 0.5),
    ];
    expect(detectPatterns(messages).some((p) => p.type === "struggle")).toBe(false);
  });

  it("breaks when a high-weight assistant message appears", () => {
    const messages = [
      wm("user", "Please fix this.", 0.5),
      wm("assistant", "Here is the full solution with detailed explanation.", 0.8), // high weight — breaks struggle
      wm("user", "Ok that worked actually.", 0.4),
      wm("assistant", "done", 0.2),
      wm("user", "Thanks, looks good.", 0.4),
    ];
    expect(detectPatterns(messages).some((p) => p.type === "struggle")).toBe(false);
  });

  it("does not fire when user messages have very different lengths", () => {
    const messages = [
      wm("user", "Fix it.", 0.5),              // short
      wm("assistant", "ok", 0.2),
      wm("user", "x".repeat(300), 0.5),        // very long — ratio > 2.0
      wm("assistant", "ok", 0.2),
      wm("user", "Fix it again.", 0.5),
    ];
    expect(detectPatterns(messages).some((p) => p.type === "struggle")).toBe(false);
  });

  it("does not break the run when assistant weight is exactly 0.5 (threshold is > 0.5)", () => {
    // Source: if (m.weight > 0.5) break — 0.5 is NOT > 0.5, so run continues
    const messages = [
      wm("user", "Please fix the login issue.", 0.5),
      wm("assistant", "Ok.", 0.5),   // exactly 0.5 — should NOT break
      wm("user", "It still does not work here.", 0.5),
      wm("assistant", "Hmm.", 0.5),  // exactly 0.5 — should NOT break
      wm("user", "Can you try again please?", 0.5),
    ];
    expect(detectPatterns(messages).some((p) => p.type === "struggle")).toBe(true);
  });

  it("breaks the run when assistant weight is 0.51 (> 0.5)", () => {
    const messages = [
      wm("user", "Please fix the login issue.", 0.5),
      wm("assistant", "Ok.", 0.51),  // 0.51 > 0.5 — breaks struggle
      wm("user", "It still does not work here.", 0.5),
      wm("assistant", "Hmm.", 0.2),
      wm("user", "Can you try again please?", 0.5),
    ];
    expect(detectPatterns(messages).some((p) => p.type === "struggle")).toBe(false);
  });
});

// ─── Exclusivity — first match wins ──────────────────────────────────────────

describe("message exclusivity", () => {
  it("a message index appears in at most one pattern", () => {
    // Must contain a decision signal so confirmation pattern fires
    const proposal = "I'll use SQLite for the database. " + "x".repeat(170);
    const messages = [
      wm("assistant", proposal, 0.8),
      wm("user", "yes", 0.3, "noise", { isShortConfirmation: true }),
      wm("user", "Still failing.", 0.5, "error"),
      wm("assistant", "Fixed.", 0.8, "conclusion"),
    ];

    const patterns = detectPatterns(messages);
    const allIndexes = patterns.flatMap((p) => p.messageIndexes);
    const unique = new Set(allIndexes);
    expect(allIndexes.length).toBe(unique.size);

    // Verify the correct pattern types were detected
    const types = patterns.map((p) => p.type);
    expect(types).toContain("confirmation");  // indexes 0,1
    expect(types).toContain("error_retry");   // indexes 2,3

    // confirmation (lower indexes) has priority over error_retry (higher indexes)
    const confirmPat = patterns.find((p) => p.type === "confirmation")!;
    const errorPat = patterns.find((p) => p.type === "error_retry")!;
    expect(Math.min(...confirmPat.messageIndexes)).toBeLessThan(Math.min(...errorPat.messageIndexes));
  });
});
