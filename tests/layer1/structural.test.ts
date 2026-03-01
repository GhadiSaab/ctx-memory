import { describe, it, expect } from "vitest";
import { extractStructuralFeatures } from "../../src/layer1/structural.js";
import type { Message } from "../../src/types/index.js";

// ─── Factory ──────────────────────────────────────────────────────────────────

function msg(content: string, role: "user" | "assistant" = "user"): Message {
  return {
    id: "test-id" as any,
    session_id: "test-session" as any,
    role,
    content,
    index: 0,
    timestamp: 0 as any,
  };
}

// ─── length ───────────────────────────────────────────────────────────────────

describe("length", () => {
  it("returns exact character count", () => {
    const f = extractStructuralFeatures(msg("hello"), 0, 1);
    expect(f.length).toBe(5);
  });

  it("counts newlines and spaces", () => {
    const content = "line one\nline two";
    const f = extractStructuralFeatures(msg(content), 0, 1);
    expect(f.length).toBe(content.length);
  });

  it("is 0 for empty string", () => {
    expect(extractStructuralFeatures(msg(""), 0, 1).length).toBe(0);
  });
});

// ─── hasCodeBlock ─────────────────────────────────────────────────────────────

describe("hasCodeBlock", () => {
  it("is true when content contains triple backtick", () => {
    expect(extractStructuralFeatures(msg("```js\nconsole.log()\n```"), 0, 1).hasCodeBlock).toBe(true);
  });

  it("is true for inline opening backticks only", () => {
    expect(extractStructuralFeatures(msg("look at this ```code"), 0, 1).hasCodeBlock).toBe(true);
  });

  it("is false with only single or double backticks", () => {
    expect(extractStructuralFeatures(msg("`single` and ``double``"), 0, 1).hasCodeBlock).toBe(false);
  });

  it("is false for plain prose", () => {
    expect(extractStructuralFeatures(msg("just some text"), 0, 1).hasCodeBlock).toBe(false);
  });
});

// ─── hasFilePath ──────────────────────────────────────────────────────────────

describe("hasFilePath", () => {
  it("detects Unix-style path", () => {
    expect(extractStructuralFeatures(msg("see ./src/index.ts"), 0, 1).hasFilePath).toBe(true);
  });

  it("detects nested path with dots", () => {
    expect(extractStructuralFeatures(msg("edit /home/user/project/main.js"), 0, 1).hasFilePath).toBe(true);
  });

  it("detects Windows-style path", () => {
    expect(extractStructuralFeatures(msg("open C:\\Users\\foo\\file.txt"), 0, 1).hasFilePath).toBe(true);
  });

  it("is false for plain words", () => {
    expect(extractStructuralFeatures(msg("just some words"), 0, 1).hasFilePath).toBe(false);
  });
});

// ─── hasUrl ───────────────────────────────────────────────────────────────────

describe("hasUrl", () => {
  it("detects https URL", () => {
    expect(extractStructuralFeatures(msg("see https://example.com"), 0, 1).hasUrl).toBe(true);
  });

  it("detects http URL", () => {
    expect(extractStructuralFeatures(msg("http://localhost:3000"), 0, 1).hasUrl).toBe(true);
  });

  it("is false without protocol", () => {
    expect(extractStructuralFeatures(msg("example.com"), 0, 1).hasUrl).toBe(false);
  });

  it("is false for ftp or other protocols", () => {
    expect(extractStructuralFeatures(msg("ftp://files.example.com"), 0, 1).hasUrl).toBe(false);
  });
});

// ─── questionCount ────────────────────────────────────────────────────────────

describe("questionCount", () => {
  it("counts a single question mark", () => {
    expect(extractStructuralFeatures(msg("Are you sure?"), 0, 1).questionCount).toBe(1);
  });

  it("counts multiple question marks", () => {
    expect(extractStructuralFeatures(msg("Why? How? When?"), 0, 1).questionCount).toBe(3);
  });

  it("is 0 for no question marks", () => {
    expect(extractStructuralFeatures(msg("Just a statement."), 0, 1).questionCount).toBe(0);
  });
});

// ─── sentenceCount ────────────────────────────────────────────────────────────

describe("sentenceCount", () => {
  it("counts sentences split by period", () => {
    expect(extractStructuralFeatures(msg("First. Second. Third."), 0, 1).sentenceCount).toBe(3);
  });

  it("counts sentences split by mixed terminators", () => {
    expect(extractStructuralFeatures(msg("Really! Is that so? Yes."), 0, 1).sentenceCount).toBe(3);
  });

  it("is 1 for a single sentence without terminator", () => {
    expect(extractStructuralFeatures(msg("just one sentence"), 0, 1).sentenceCount).toBe(1);
  });

  it("is 0 for empty content", () => {
    expect(extractStructuralFeatures(msg(""), 0, 1).sentenceCount).toBe(0);
  });

  it("does not count consecutive terminators as extra sentences", () => {
    // "Hello..." splits on /[.!?]+/ — trailing empty strings are filtered
    const f = extractStructuralFeatures(msg("Hello..."), 0, 1);
    expect(f.sentenceCount).toBe(1);
  });
});

// ─── imperativeCount ──────────────────────────────────────────────────────────

describe("imperativeCount", () => {
  it("counts sentences starting with an imperative verb", () => {
    const f = extractStructuralFeatures(msg("Fix the bug. Add a test. Great work."), 0, 1);
    expect(f.imperativeCount).toBe(2);
  });

  it("is case-insensitive", () => {
    const f = extractStructuralFeatures(msg("CREATE the table. Run it now."), 0, 1);
    expect(f.imperativeCount).toBe(2);
  });

  it("is 0 when no sentences start with an imperative verb", () => {
    const f = extractStructuralFeatures(msg("The system is broken. It needs a fix."), 0, 1);
    expect(f.imperativeCount).toBe(0);
  });
});

// ─── startsWithVerb ───────────────────────────────────────────────────────────

describe("startsWithVerb", () => {
  it("is true when first word is in the imperative list", () => {
    for (const verb of ["Fix", "add", "CREATE", "refactor", "deploy"]) {
      expect(extractStructuralFeatures(msg(`${verb} something`), 0, 1).startsWithVerb).toBe(true);
    }
  });

  it("is false when first word is not in the list", () => {
    expect(extractStructuralFeatures(msg("The system crashed"), 0, 1).startsWithVerb).toBe(false);
  });

  it("is false for empty content", () => {
    expect(extractStructuralFeatures(msg(""), 0, 1).startsWithVerb).toBe(false);
  });

  it("requires the full first word — 'fixes' does not match 'fix'", () => {
    // RE uses \b so "fixes" would still match /^fix\b/ — it does NOT match
    expect(extractStructuralFeatures(msg("fixes the bug"), 0, 1).startsWithVerb).toBe(false);
  });
});

// ─── isShortConfirmation ─────────────────────────────────────────────────────

describe("isShortConfirmation", () => {
  it("is true for exact confirmation words from the user", () => {
    for (const word of ["yes", "no", "ok", "okay", "sure", "done", "correct", "right", "nope"]) {
      const f = extractStructuralFeatures(msg(word, "user"), 0, 1);
      expect(f.isShortConfirmation).toBe(true);
    }
  });

  it("is true for multi-word confirmations under 30 chars", () => {
    expect(extractStructuralFeatures(msg("looks good", "user"), 0, 1).isShortConfirmation).toBe(true);
    expect(extractStructuralFeatures(msg("that works", "user"), 0, 1).isShortConfirmation).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(extractStructuralFeatures(msg("YES", "user"), 0, 1).isShortConfirmation).toBe(true);
    expect(extractStructuralFeatures(msg("Okay", "user"), 0, 1).isShortConfirmation).toBe(true);
  });

  it("is false when role is assistant", () => {
    expect(extractStructuralFeatures(msg("yes", "assistant"), 0, 1).isShortConfirmation).toBe(false);
  });

  it("is false when content is >= 30 characters even if it matches", () => {
    // pad a confirmation word past the length threshold
    const long = "yes " + "x".repeat(30);
    expect(extractStructuralFeatures(msg(long, "user"), 0, 1).isShortConfirmation).toBe(false);
  });

  it("is false for non-confirmation short user messages", () => {
    expect(extractStructuralFeatures(msg("what?", "user"), 0, 1).isShortConfirmation).toBe(false);
  });
});

// ─── positionalWeight ────────────────────────────────────────────────────────

describe("positionalWeight", () => {
  it("returns 1.0 for the first message (index 0)", () => {
    expect(extractStructuralFeatures(msg("hi"), 0, 10).positionalWeight).toBe(1.0);
  });

  it("returns 0.8 for the last message", () => {
    // total = 10, last index = 9 → within last 3 (indices 7, 8, 9)
    expect(extractStructuralFeatures(msg("bye"), 9, 10).positionalWeight).toBe(0.8);
  });

  it("returns 0.8 for the second-to-last message", () => {
    expect(extractStructuralFeatures(msg("almost"), 8, 10).positionalWeight).toBe(0.8);
  });

  it("returns 0.7 for a message in the first 10% (but not index 0)", () => {
    // total = 100 — index 5 is in first 10% but not index 0
    expect(extractStructuralFeatures(msg("early"), 5, 100).positionalWeight).toBe(0.7);
  });

  it("returns 0.4 for a message in the middle", () => {
    // total = 100, index = 50 — middle of conversation
    expect(extractStructuralFeatures(msg("middle"), 50, 100).positionalWeight).toBe(0.4);
  });

  it("returns 1.0 for total = 0 (edge case)", () => {
    expect(extractStructuralFeatures(msg("solo"), 0, 0).positionalWeight).toBe(1.0);
  });

  it("last-3 takes priority over first-10% for very short conversations", () => {
    // total = 5 — index 1 is in last 3 (indices 2,3,4? no — last 3 of 5 are 2,3,4)
    // index 3 is in last 3 AND first 10% is only index 0 → returns 0.8
    expect(extractStructuralFeatures(msg("x"), 3, 5).positionalWeight).toBe(0.8);
  });
});
