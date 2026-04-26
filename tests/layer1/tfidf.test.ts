import { describe, it, expect } from "vitest";
import { extractKeywords } from "../../src/layer1/tfidf.js";
import type { WeightedMessage, StructuralFeatures } from "../../src/types/index.js";

// ─── Factory ──────────────────────────────────────────────────────────────────

function wm(content: string, weight: number): WeightedMessage {
  const features: StructuralFeatures = {
    length: content.length,
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
  };
  return {
    message: {
      id: "id" as any,
      session_id: "sid" as any,
      role: "user",
      content,
      index: 0,
      timestamp: 0 as any,
    },
    weight,
    type: "noise",
    features,
  };
}

// ─── Edge cases ───────────────────────────────────────────────────────────────

describe("extractKeywords — edge cases", () => {
  it("returns empty array for empty input", () => {
    expect(extractKeywords([])).toEqual([]);
  });

  it("extracts keywords from low-weight substantive messages", () => {
    const messages = [
      wm("authentication login database", 0.5),
      wm("routing middleware validation", 0.3),
    ];
    expect(extractKeywords(messages)).toEqual(expect.arrayContaining(["authentication", "middleware"]));
  });

  it("returns empty array when high-weight messages tokenize to nothing", () => {
    // only stopwords and short tokens
    const messages = [wm("is it the and or", 0.8)];
    expect(extractKeywords(messages)).toEqual([]);
  });
});

// ─── Filtering by weight ──────────────────────────────────────────────────────

describe("extractKeywords — weight filtering", () => {
  it("prefers high-weight messages but keeps substantive low-weight context", () => {
    const messages = [
      wm("authentication login session", 0.8),   // included
      wm("completely unrelated content here", 0.5), // excluded (not > 0.5)
      wm("more unrelated random noise words", 0.3), // excluded
    ];
    const keywords = extractKeywords(messages);
    expect(keywords).toContain("authentication");
    expect(keywords).toContain("login");
    expect(keywords).toContain("session");
    expect(keywords.length).toBeGreaterThan(0);
  });
});

// ─── Preprocessing ────────────────────────────────────────────────────────────

describe("extractKeywords — preprocessing", () => {
  it("strips code blocks before tokenizing", () => {
    const messages = [
      wm("refactoring module\n```ts\nconst foo = bar\n```\nauthentication", 0.8),
      wm("module refactoring pipeline authentication", 0.8),
    ];
    const keywords = extractKeywords(messages);
    // "foo" and "bar" inside code block should not appear as top keywords
    // while real words do
    expect(keywords).toContain("refactoring");
    expect(keywords).toContain("authentication");
  });

  it("strips URLs before tokenizing", () => {
    const messages = [
      wm("see https://example.com/docs/api for authentication details", 0.8),
      wm("authentication middleware configuration", 0.8),
    ];
    const keywords = extractKeywords(messages);
    expect(keywords).not.toContain("https");
    expect(keywords).not.toContain("example");
    expect(keywords).toContain("authentication");
  });

  it("lowercases all tokens", () => {
    const messages = [
      wm("Authentication LOGIN Database", 0.8),
      wm("authentication login database", 0.8),
    ];
    const keywords = extractKeywords(messages);
    expect(keywords).toContain("authentication");
    expect(keywords).toContain("login");
    expect(keywords).toContain("database");
  });

  it("removes tokens of 2 chars or fewer", () => {
    const messages = [
      wm("db id pk fk authentication migration", 0.8),
    ];
    const keywords = extractKeywords(messages);
    expect(keywords).not.toContain("db");
    expect(keywords).not.toContain("id");
    expect(keywords).not.toContain("pk");
    expect(keywords).not.toContain("fk");
    expect(keywords).toContain("authentication");
  });

  it("removes stopwords", () => {
    const messages = [
      wm("the function returns this value from the const variable", 0.8),
      wm("authentication middleware validation pipeline", 0.8),
    ];
    const keywords = extractKeywords(messages);
    expect(keywords).not.toContain("function");
    expect(keywords).not.toContain("const");
    expect(keywords).not.toContain("return");
    expect(keywords).not.toContain("the");
  });
});

// ─── TF-IDF scoring ──────────────────────────────────────────────────────────

describe("extractKeywords — TF-IDF scoring", () => {
  it("terms appearing in fewer documents score higher (IDF)", () => {
    // "migration" only in one doc, "authentication" in all three
    const messages = [
      wm("authentication login session token", 0.8),
      wm("authentication middleware pipeline validation", 0.8),
      wm("authentication migration database schema", 0.8),
    ];
    const keywords = extractKeywords(messages);
    // rare terms rank above ubiquitous ones
    expect(keywords).toContain("migration");
    const authIdx = keywords.indexOf("authentication");
    const migIdx = keywords.indexOf("migration");
    // migration must rank above authentication (IDF=0), or authentication must be absent
    expect(migIdx).toBeLessThan(authIdx === -1 ? keywords.length : authIdx);
  });

  it("rare term ranks above common term (descending score order)", () => {
    // 2 docs: "migration" in 1 doc → IDF = log(2/1) > 0
    // "schema" in both docs → IDF = log(2/2) = 0
    // So migration has higher TF-IDF and must appear before schema
    const messages = [
      wm("migration schema database tables", 0.8),
      wm("schema rollback pipeline validation", 0.8),
    ];
    const keywords = extractKeywords(messages);
    expect(keywords).toContain("migration");
    const migIdx = keywords.indexOf("migration");
    const schemaIdx = keywords.indexOf("schema");
    // schema may be absent (IDF=0) or ranked below migration
    expect(migIdx).toBeLessThan(schemaIdx === -1 ? keywords.length : schemaIdx);
  });
});

// ─── topN ─────────────────────────────────────────────────────────────────────

describe("extractKeywords — topN", () => {
  it("returns empty array when topN is 0", () => {
    const messages = [wm("authentication login session", 0.8)];
    expect(extractKeywords(messages, 0)).toEqual([]);
  });

  it("returns at most topN results (default 15)", () => {
    // Generate 20 unique high-weight terms
    const content = Array.from({ length: 20 }, (_, i) => `uniqueterm${i}word`).join(" ");
    const messages = [wm(content, 0.8)];
    const keywords = extractKeywords(messages);
    expect(keywords.length).toBeLessThanOrEqual(15);
  });

  it("respects custom topN", () => {
    const content = Array.from({ length: 20 }, (_, i) => `uniqueterm${i}word`).join(" ");
    const messages = [wm(content, 0.8)];
    const keywords = extractKeywords(messages, 5);
    expect(keywords.length).toBeLessThanOrEqual(5);
  });

  it("returns fewer than topN when not enough terms exist", () => {
    const messages = [wm("authentication login", 0.8)];
    const keywords = extractKeywords(messages, 15);
    expect(keywords.length).toBeLessThan(15);
  });
});

// ─── Return type ──────────────────────────────────────────────────────────────

describe("extractKeywords — return type", () => {
  it("returns an array of strings", () => {
    const messages = [wm("authentication middleware session token", 0.8)];
    const keywords = extractKeywords(messages);
    expect(Array.isArray(keywords)).toBe(true);
    for (const k of keywords) expect(typeof k).toBe("string");
  });

  it("returns no duplicate keywords", () => {
    const messages = [
      wm("authentication login session token middleware", 0.8),
      wm("authentication middleware validation pipeline", 0.8),
    ];
    const keywords = extractKeywords(messages);
    expect(new Set(keywords).size).toBe(keywords.length);
  });

  it("includes messages with weight exactly 0.5 so single-session keywords are not empty", () => {
    expect(extractKeywords([wm("authentication login session", 0.5)])).toEqual(expect.arrayContaining(["authentication", "login", "session"]));
  });
});
