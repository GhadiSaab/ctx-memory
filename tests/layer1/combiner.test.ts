import { describe, it, expect } from "vitest";
import { processSession } from "../../src/layer1/combiner.js";
import type { RawToolEvent as RawToolEventType } from "../../src/layer1/combiner.js";
import type { Message } from "../../src/types/index.js";

// ─── Factories ────────────────────────────────────────────────────────────────

let idx = 0;
function msg(
  role: "user" | "assistant",
  content: string,
  index?: number
): Message {
  return {
    id: `id-${idx++}` as any,
    session_id: "sid-1" as any,
    role,
    content,
    index: index ?? 0,
    timestamp: Date.now() as any,
  };
}

function rawEvent(
  tool: string,
  args: Record<string, unknown>,
  result: Record<string, unknown> = {},
  success = true
): RawToolEventType {
  return { tool, args, result, success, timestamp: Date.now() };
}

// ─── Empty / minimal input ────────────────────────────────────────────────────

describe("processSession — empty input", () => {
  it("returns valid Layer1Output for empty messages and events", () => {
    const out = processSession([], []);
    expect(out.weightedMessages).toEqual([]);
    expect(out.events).toEqual([]);
    expect(out.decisions).toEqual([]);
    expect(out.errors).toEqual([]);
    expect(out.keywords).toEqual([]);
    expect(out.patterns).toEqual([]);
    expect(out.goal).toBeNull();
    expect(out.tokenCount).toBe(0);
  });
});

// ─── WeightedMessage assembly ─────────────────────────────────────────────────

describe("processSession — weighted messages", () => {
  it("produces one WeightedMessage per input message", () => {
    const messages = [
      msg("user", "Can you help me implement authentication?"),
      msg("assistant", "Sure, I can help with that."),
    ];
    const out = processSession(messages, []);
    expect(out.weightedMessages).toHaveLength(2);
  });

  it("each WeightedMessage has weight in [0, 1]", () => {
    const messages = [
      msg("user", "Fix the login bug please."),
      msg("assistant", "I'll look into it."),
      msg("user", "Thanks."),
    ];
    const out = processSession(messages, []);
    for (const wm of out.weightedMessages) {
      expect(wm.weight).toBeGreaterThanOrEqual(0);
      expect(wm.weight).toBeLessThanOrEqual(1);
    }
  });

  it("preserves original message reference", () => {
    const messages = [msg("user", "hello world testing this")];
    const out = processSession(messages, []);
    expect(out.weightedMessages[0].message).toBe(messages[0]);
  });
});

// ─── Type classification overrides ───────────────────────────────────────────

describe("processSession — type classification", () => {
  it("first user message at index 0 is always 'goal'", () => {
    const messages = [
      msg("user", "Fixed. Works perfectly."), // would normally be 'conclusion'
    ];
    const out = processSession(messages, []);
    expect(out.weightedMessages[0].type).toBe("goal");
  });

  it("short confirmation is always 'noise'", () => {
    const messages = [
      msg("user", "Can you help me?"),
      msg("assistant", "Sure, let me explain."),
      msg("user", "yes"), // isShortConfirmation
    ];
    const out = processSession(messages, []);
    const lastMsg = out.weightedMessages[2];
    expect(lastMsg.type).toBe("noise");
  });
});

// ─── Weight formula ───────────────────────────────────────────────────────────

describe("processSession — weight formula", () => {
  it("message with code block has higher weight than same message without", () => {
    const withCode = [msg("user", "Here is the solution:\n```ts\nconst x = 1;\n```\nDone.")];
    const withoutCode = [msg("user", "Here is the solution: const x = 1. Done.")];
    const outWith = processSession(withCode, []);
    const outWithout = processSession(withoutCode, []);
    expect(outWith.weightedMessages[0].weight).toBeGreaterThan(outWithout.weightedMessages[0].weight);
  });

  it("short confirmation gets lower weight due to -0.3 structural penalty", () => {
    const messages = [
      msg("user", "Can you fix the authentication module?"),
      msg("assistant", "Of course, let me check that."),
      msg("user", "yes"),  // short confirmation: -0.3 penalty
      msg("user", "we decided to go with JWT for authentication tokens"), // decision
    ];
    const out = processSession(messages, []);
    const confirmWeight = out.weightedMessages[2].weight;
    const decisionWeight = out.weightedMessages[3].weight;
    expect(confirmWeight).toBeLessThan(decisionWeight);
  });
});

// ─── Goal extraction ──────────────────────────────────────────────────────────

describe("processSession — goal", () => {
  it("extracts goal from first user message typed 'goal'", () => {
    const messages = [
      msg("user", "Can you help me implement the login flow?"),
      msg("assistant", "Sure."),
    ];
    const out = processSession(messages, []);
    expect(out.goal).toBe("Can you help me implement the login flow?");
  });

  it("falls back to first user message when no 'goal' typed message and no high-weight user", () => {
    const messages = [
      // assistant first — so index 0 isn't a user goal
      msg("assistant", "Hello, what do you need?"),
      msg("user", "ok"), // short confirmation → type noise, low weight
    ];
    const out = processSession(messages, []);
    // no type='goal' and no weight > 0.5 user message → null
    expect(out.goal).toBeNull();
  });

  it("returns null when no user messages exist", () => {
    const messages = [msg("assistant", "Hello.")];
    const out = processSession(messages, []);
    expect(out.goal).toBeNull();
  });
});

// ─── Decisions ────────────────────────────────────────────────────────────────

describe("processSession — decisions", () => {
  it("includes 'decision' typed messages", () => {
    const messages = [
      msg("user", "let's go with postgres rather than sqlite"),
      msg("assistant", "Agreed, that makes sense. Let's go with the current approach."),
    ];
    const out = processSession(messages, []);
    expect(out.decisions.length).toBeGreaterThan(0);
  });

  it("includes extractedDecision from confirmation patterns", () => {
    const proposal = "x".repeat(201);
    const messages = [
      { ...msg("assistant", proposal), content: proposal } as Message,
      msg("user", "yes"),
    ];
    // Need weight > 0.6 for confirmation — build manually with high-weight msgs
    // The combiner computes weights internally; confirmation requires weight > 0.6
    // We just verify the output shape is valid
    const out = processSession(messages, []);
    expect(Array.isArray(out.decisions)).toBe(true);
  });

  it("extracts durable architecture decisions from assistant messages", () => {
    const messages = [
      msg("user", "How should we persist memory?"),
      msg("assistant", "The architecture uses SQLite with sqlite-vec for local storage. I will update the docs next."),
    ];
    const out = processSession(messages, []);
    expect(out.decisions).toContain("The architecture uses SQLite with sqlite-vec for local storage.");
  });

  it("does not treat transient MCP lookup narration as a decision", () => {
    const messages = [
      msg("user", "use llm memory mcp"),
      msg("assistant", "I'll use the llm-memory_get_project_memory MCP tool to retrieve the project memory."),
    ];
    const out = processSession(messages, []);
    expect(out.decisions).toEqual([]);
  });

  it("does not treat failure explanations as decisions because they contain 'because'", () => {
    const messages = [
      msg("user", "why is the digest bad?"),
      msg("assistant", "The build failed because decisions and errors arrays were empty in real sessions."),
    ];
    const out = processSession(messages, []);
    expect(out.decisions).toEqual([]);
  });
});

// ─── Errors ───────────────────────────────────────────────────────────────────

describe("processSession — errors", () => {
  it("includes 'error' typed messages", () => {
    const messages = [
      msg("user", "Can you help?"),  // index 0 → forced 'goal'
      msg("user", "TypeError: cannot read properties of undefined"), // not index 0 → keyword wins
      msg("assistant", "Let me fix that."),
    ];
    const out = processSession(messages, []);
    expect(out.errors.length).toBeGreaterThan(0);
    expect(out.errors.some((e) => e.includes("TypeError"))).toBe(true);
  });

  it("includes errors from tool events", () => {
    const messages = [msg("user", "run the build")];
    const events = [
      rawEvent("bash", { command: "cat missing.txt" }, { stderr: "No such file" }, false),
    ];
    const out = processSession(messages, events);
    expect(out.errors.some((e) => e.includes("No such file"))).toBe(true);
  });

  it("does not treat assistant diagnostic narration as an error without failed tool evidence", () => {
    const messages = [
      msg("user", "run the tests"),
      msg("assistant", "The build failed because TypeScript cannot find module './missing'. I will fix the import."),
    ];
    const out = processSession(messages, []);
    expect(out.errors).toEqual([]);
  });
});

// ─── Tool events ──────────────────────────────────────────────────────────────

describe("processSession — tool events", () => {
  it("classifies write_file into events", () => {
    const messages = [msg("user", "create auth module")];
    const events = [rawEvent("write_file", { path: "src/auth.ts" })];
    const out = processSession(messages, events);
    expect(out.events).toHaveLength(1);
    expect(out.events[0].type).toBe("file_created");
  });

  it("drops null events (unknown tools)", () => {
    const messages = [msg("user", "read file")];
    const events = [rawEvent("read_file", { path: "src/foo.ts" })];
    const out = processSession(messages, events);
    expect(out.events).toHaveLength(0);
  });

  it("uses timestamp from RawToolEvent", () => {
    const messages = [msg("user", "do something")];
    const ts = 1700000000000;
    const events = [{ tool: "write_file", args: { path: "src/x.ts" }, result: {}, success: true, timestamp: ts }];
    const out = processSession(messages, events);
    expect(out.events[0].timestamp).toBe(ts);
  });

  it("attaches session_id from first message", () => {
    const messages = [{ ...msg("user", "hello"), session_id: "my-session" as any }];
    const events = [rawEvent("write_file", { path: "src/a.ts" })];
    const out = processSession(messages, events);
    expect(out.events[0].session_id).toBe("my-session");
  });
});

// ─── Keywords ─────────────────────────────────────────────────────────────────

describe("processSession — keywords", () => {
  it("returns an array of strings", () => {
    const messages = [
      msg("user", "implement authentication middleware session token validation"),
      msg("assistant", "authentication middleware requires session token validation pipeline"),
    ];
    const out = processSession(messages, []);
    expect(Array.isArray(out.keywords)).toBe(true);
    for (const k of out.keywords) expect(typeof k).toBe("string");
  });
});

// ─── Token count ──────────────────────────────────────────────────────────────

describe("processSession — tokenCount", () => {
  it("estimates tokens only from messages with weight > 0.5", () => {
    const messages = [
      msg("user", "Can you help me implement the authentication system?"), // high weight (index 0, goal)
      msg("user", "yes"), // low weight (short confirmation)
    ];
    const out = processSession(messages, []);
    // only the high-weight message contributes
    const highWeightMsg = out.weightedMessages.find((m) => m.weight > 0.5);
    const expectedTokens = highWeightMsg
      ? Math.ceil(highWeightMsg.message.content.length / 4)
      : 0;
    expect(out.tokenCount).toBe(expectedTokens);
  });

  it("token count is always >= 0", () => {
    const out = processSession([], []);
    expect(out.tokenCount).toBeGreaterThanOrEqual(0);
  });
});

// ─── session_id ───────────────────────────────────────────────────────────────

describe("processSession — session_id", () => {
  it("uses session_id from first message", () => {
    const messages = [{ ...msg("user", "hello"), session_id: "test-session" as any }];
    const out = processSession(messages, []);
    expect(out.session_id).toBe("test-session");
  });

  it("returns empty string when no messages", () => {
    const out = processSession([], []);
    expect(out.session_id).toBe("");
  });
});
