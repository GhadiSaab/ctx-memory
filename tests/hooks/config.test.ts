// Tests for hook config generators and writers.
// Config writers touch the filesystem — we test in a temp dir.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildClaudeHookConfig,
  buildGeminiHookConfig,
  buildOpenCodeHookConfig,
} from "../../src/hooks/index.js";
import {
  writeClaudeHooks,
  writeGeminiHooks,
  writeOpenCodeHooks,
} from "../../src/hooks/index.js";

// ─── Temp dir ─────────────────────────────────────────────────────────────────

let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "llm-memory-hooks-test-"));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ─── buildClaudeHookConfig ────────────────────────────────────────────────────

describe("buildClaudeHookConfig", () => {
  it("returns an object with PostToolUse hooks", () => {
    const config = buildClaudeHookConfig();
    expect(config).toHaveProperty("hooks.PostToolUse");
  });

  it("PostToolUse hook command references hook-receiver", () => {
    const config = buildClaudeHookConfig();
    const hook = config.hooks.PostToolUse[0].hooks[0];
    expect(hook.command).toContain("hook-receiver");
  });

  it("hook command includes $LLM_MEMORY_SESSION_ID", () => {
    const config = buildClaudeHookConfig();
    const post = config.hooks.PostToolUse[0].hooks[0].command;
    expect(post).toContain("$LLM_MEMORY_SESSION_ID");
  });

  it("matcher is '*' (all tools)", () => {
    const config = buildClaudeHookConfig();
    expect(config.hooks.PostToolUse[0].matcher).toBe("*");
  });
});

// ─── buildGeminiHookConfig ────────────────────────────────────────────────────

describe("buildGeminiHookConfig", () => {
  it("returns BeforeTool and AfterTool string commands", () => {
    const config = buildGeminiHookConfig();
    expect(typeof config.hooks.BeforeTool).toBe("string");
    expect(typeof config.hooks.AfterTool).toBe("string");
  });

  it("commands reference hook-receiver", () => {
    const config = buildGeminiHookConfig();
    expect(config.hooks.BeforeTool).toContain("hook-receiver");
    expect(config.hooks.AfterTool).toContain("hook-receiver");
  });
});

// ─── buildOpenCodeHookConfig ──────────────────────────────────────────────────

describe("buildOpenCodeHookConfig", () => {
  it("returns an OpenCode plugin path and content", () => {
    const config = buildOpenCodeHookConfig();
    expect(config.pluginPath).toBe("plugins/llm-memory.js");
    expect(config.content).toContain("tool.execute.after");
  });

  it("plugin content references hook-receiver", () => {
    const config = buildOpenCodeHookConfig();
    expect(config.content).toContain("hook-receiver");
    expect(config.content).toContain("LLM_MEMORY_SESSION_ID");
  });
});

// ─── writeClaudeHooks ─────────────────────────────────────────────────────────

describe("writeClaudeHooks", () => {
  it("creates settings.json when it does not exist", () => {
    const claudeDir = join(tmpDir, ".claude");
    mkdirSync(claudeDir);
    writeClaudeHooks(claudeDir, "/tmp/session-start");

    const written = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf8"));
    expect(written).toHaveProperty("hooks.PostToolUse");
  });

  it("merges into existing settings.json without destroying other keys", () => {
    const claudeDir = join(tmpDir, ".claude");
    mkdirSync(claudeDir);
    const existing = { theme: "dark", model: "claude-opus", customKey: 42 };
    writeFileSync(join(claudeDir, "settings.json"), JSON.stringify(existing));

    writeClaudeHooks(claudeDir, "/tmp/session-start");

    const written = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf8"));
    expect(written.theme).toBe("dark");
    expect(written.model).toBe("claude-opus");
    expect(written.customKey).toBe(42);
  });

  it("is idempotent — running twice does not duplicate hooks", () => {
    const claudeDir = join(tmpDir, ".claude");
    mkdirSync(claudeDir);
    writeClaudeHooks(claudeDir, "/tmp/session-start");
    writeClaudeHooks(claudeDir, "/tmp/session-start");

    const written = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf8"));
    expect(written.hooks.PostToolUse).toHaveLength(1);
  });
});

// ─── writeGeminiHooks ─────────────────────────────────────────────────────────

describe("writeGeminiHooks", () => {
  it("creates settings.json when it does not exist", () => {
    writeGeminiHooks(tmpDir);

    const written = JSON.parse(readFileSync(join(tmpDir, "settings.json"), "utf8"));
    expect(written).toHaveProperty("hooks.BeforeTool");
    expect(written).toHaveProperty("hooks.AfterTool");
  });

  it("merges without destroying existing keys", () => {
    const existing = { theme: "dark", apiKey: "abc123" };
    writeFileSync(join(tmpDir, "settings.json"), JSON.stringify(existing));

    writeGeminiHooks(tmpDir);

    const written = JSON.parse(readFileSync(join(tmpDir, "settings.json"), "utf8"));
    expect(written.theme).toBe("dark");
    expect(written.apiKey).toBe("abc123");
    expect(written).toHaveProperty("hooks.BeforeTool");
  });
});

// ─── writeOpenCodeHooks ───────────────────────────────────────────────────────

describe("writeOpenCodeHooks", () => {
  it("creates a global OpenCode plugin when it does not exist", () => {
    writeOpenCodeHooks(tmpDir);

    const written = readFileSync(join(tmpDir, "plugins", "llm-memory.js"), "utf8");
    expect(written).toContain("tool.execute.after");
    expect(written).toContain("hook-receiver");
  });

  it("does not touch existing opencode.json settings", () => {
    const existing = { provider: "anthropic", model: "claude-3" };
    writeFileSync(join(tmpDir, "opencode.json"), JSON.stringify(existing));

    writeOpenCodeHooks(tmpDir);

    const written = JSON.parse(readFileSync(join(tmpDir, "opencode.json"), "utf8"));
    expect(written.provider).toBe("anthropic");
    expect(written.model).toBe("claude-3");
    expect(readFileSync(join(tmpDir, "plugins", "llm-memory.js"), "utf8")).toContain("LLMMemoryPlugin");
  });
});
