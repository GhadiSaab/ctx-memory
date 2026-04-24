import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  resolveOutcome,
  findRealBinary,
  normalizeToolName,
  injectCodexContext,
  injectGeminiContext,
} from "../../src/wrapper/index.js";
import { clearDb } from "../db/helpers.js";

// ─── resolveOutcome ───────────────────────────────────────────────────────────

describe("resolveOutcome", () => {
  it("returns 'completed' for exit code 0", () => {
    expect(resolveOutcome(0, null)).toBe("completed");
  });

  it("returns 'interrupted' for exit code 130 (Ctrl+C)", () => {
    expect(resolveOutcome(130, null)).toBe("interrupted");
  });

  it("returns 'interrupted' when a signal is received", () => {
    expect(resolveOutcome(null, "SIGINT")).toBe("interrupted");
    expect(resolveOutcome(null, "SIGTERM")).toBe("interrupted");
  });

  it("returns 'crashed' for non-zero, non-130 exit codes", () => {
    expect(resolveOutcome(1, null)).toBe("crashed");
    expect(resolveOutcome(127, null)).toBe("crashed");
    expect(resolveOutcome(255, null)).toBe("crashed");
  });

  it("returns 'crashed' when both code and signal are null", () => {
    expect(resolveOutcome(null, null)).toBe("crashed");
  });
});

// ─── findRealBinary ───────────────────────────────────────────────────────────

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, accessSync: vi.fn() };
});

import { accessSync } from "node:fs";
const mockAccess = vi.mocked(accessSync);

beforeEach(() => {
  vi.clearAllMocks();
  clearDb();
});

describe("findRealBinary", () => {
  it("skips ~/.llm-memory/bin/ entries to avoid infinite loop", () => {
    // Only the llm-memory/bin path throws, others succeed
    mockAccess.mockImplementation((p) => {
      if (String(p).includes(".llm-memory/bin")) throw new Error("skip");
      // first non-skipped path succeeds
    });
    const result = findRealBinary("claude", [
      "/home/user/.llm-memory/bin",
      "/usr/local/bin",
    ]);
    expect(result).toBe("/usr/local/bin/claude");
  });

  it("returns the first accessible binary not in llm-memory/bin", () => {
    mockAccess.mockImplementation((p) => {
      if (String(p) !== "/usr/local/bin/claude") throw new Error("not found");
    });
    const result = findRealBinary("claude", ["/usr/local/bin", "/usr/bin"]);
    expect(result).toBe("/usr/local/bin/claude");
  });

  it("throws when no accessible binary is found outside llm-memory/bin", () => {
    mockAccess.mockImplementation(() => { throw new Error("not found"); });
    expect(() => findRealBinary("claude", ["/usr/local/bin"])).toThrow();
  });

  it("tries all PATH entries before giving up", () => {
    let callCount = 0;
    mockAccess.mockImplementation((p) => {
      callCount++;
      if (callCount < 3) throw new Error("not found");
      // third call succeeds
    });
    const result = findRealBinary("claude", ["/a", "/b", "/c"]);
    expect(result).toBe("/c/claude");
  });
});

describe("normalizeToolName", () => {
  it("maps the claude binary name to the internal tool id", () => {
    expect(normalizeToolName("claude")).toBe("claude-code");
  });

  it("leaves gemini unchanged", () => {
    expect(normalizeToolName("gemini")).toBe("gemini");
  });
});
