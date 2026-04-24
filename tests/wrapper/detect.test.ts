import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { detectTool } from "../../src/wrapper/detect.js";

// Save and restore process.argv around each test
let originalArgv: string[];
beforeEach(() => { originalArgv = process.argv; });
afterEach(() => { process.argv = originalArgv; });

describe("detectTool", () => {
  it("returns 'claude' when argv[1] basename is 'claude'", () => {
    process.argv = ["node", "/usr/local/bin/claude", "--some-flag"];
    expect(detectTool()).toBe("claude");
  });

  it("returns 'codex' when argv[1] basename is 'codex'", () => {
    process.argv = ["node", "/home/user/.local/bin/codex"];
    expect(detectTool()).toBe("codex");
  });

  it("returns 'gemini' when argv[1] basename is 'gemini'", () => {
    process.argv = ["node", "/usr/bin/gemini"];
    expect(detectTool()).toBe("gemini");
  });

  it("returns 'opencode' when argv[1] basename is 'opencode'", () => {
    process.argv = ["node", "/usr/local/bin/opencode"];
    expect(detectTool()).toBe("opencode");
  });

  it("throws for an unknown binary name", () => {
    process.argv = ["node", "/usr/local/bin/cursor"];
    expect(() => detectTool()).toThrow();
  });

  it("throws when argv[1] is undefined", () => {
    process.argv = ["node"];
    expect(() => detectTool()).toThrow();
  });
});
