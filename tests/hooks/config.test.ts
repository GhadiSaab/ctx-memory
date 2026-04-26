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
  tmpDir = mkdtempSync(join(tmpdir(), "ctx-memory-hooks-test-"));
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

  it("hook command includes $CTX_MEMORY_SESSION_ID", () => {
    const config = buildClaudeHookConfig();
    const post = config.hooks.PostToolUse[0].hooks[0].command;
    expect(post).toContain("$CTX_MEMORY_SESSION_ID");
  });

  it("matcher is '*' (all tools)", () => {
    const config = buildClaudeHookConfig();
    expect(config.hooks.PostToolUse[0].matcher).toBe("*");
  });
});

// ─── buildGeminiHookConfig ────────────────────────────────────────────────────

describe("buildGeminiHookConfig", () => {
  it("returns AfterTool as an array of matcher objects", () => {
    const config = buildGeminiHookConfig();
    expect(Array.isArray(config.hooks.AfterTool)).toBe(true);
    expect(config.hooks.AfterTool[0]).toHaveProperty("matcher");
    expect(config.hooks.AfterTool[0]).toHaveProperty("hooks");
  });

  it("AfterTool hook uses command type and references hook-receiver", () => {
    const config = buildGeminiHookConfig();
    const hook = config.hooks.AfterTool[0].hooks[0];
    expect(hook.type).toBe("command");
    expect(hook.command).toContain("hook-receiver");
  });

  it("AfterTool hook includes $CTX_MEMORY_SESSION_ID", () => {
    const config = buildGeminiHookConfig();
    const hook = config.hooks.AfterTool[0].hooks[0];
    expect(hook.command).toContain("$CTX_MEMORY_SESSION_ID");
  });

  it("AfterTool hook has a name and timeout", () => {
    const config = buildGeminiHookConfig();
    const hook = config.hooks.AfterTool[0].hooks[0];
    expect(hook.name).toBe("ctx-memory-after-tool");
    expect(hook.timeout).toBeGreaterThan(0);
  });
});

// ─── buildOpenCodeHookConfig ──────────────────────────────────────────────────

describe("buildOpenCodeHookConfig", () => {
  it("returns an OpenCode plugin path and content", () => {
    const config = buildOpenCodeHookConfig();
    expect(config.pluginPath).toBe("plugins/ctx-memory.js");
    expect(config.content).toContain("tool.execute.after");
  });

  it("plugin content references hook-receiver", () => {
    const config = buildOpenCodeHookConfig();
    expect(config.content).toContain("hook-receiver");
    expect(config.content).toContain("CTX_MEMORY_SESSION_ID");
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
  it("creates settings.json with AfterTool array when file does not exist", () => {
    writeGeminiHooks(tmpDir);

    const written = JSON.parse(readFileSync(join(tmpDir, "settings.json"), "utf8"));
    expect(Array.isArray(written.hooks.AfterTool)).toBe(true);
    expect(written.hooks.AfterTool[0]).toHaveProperty("matcher");
  });

  it("merges without destroying existing top-level keys", () => {
    const existing = { theme: "dark", apiKey: "abc123" };
    writeFileSync(join(tmpDir, "settings.json"), JSON.stringify(existing));

    writeGeminiHooks(tmpDir);

    const written = JSON.parse(readFileSync(join(tmpDir, "settings.json"), "utf8"));
    expect(written.theme).toBe("dark");
    expect(written.apiKey).toBe("abc123");
    expect(Array.isArray(written.hooks.AfterTool)).toBe(true);
  });

  it("preserves existing AfterTool hooks (e.g. GSD hooks) and appends ours", () => {
    const existing = {
      hooks: {
        AfterTool: [
          {
            hooks: [{ type: "command", command: "node /path/to/gsd-context-monitor.js" }],
          },
        ],
      },
    };
    writeFileSync(join(tmpDir, "settings.json"), JSON.stringify(existing));

    writeGeminiHooks(tmpDir);

    const written = JSON.parse(readFileSync(join(tmpDir, "settings.json"), "utf8"));
    expect(written.hooks.AfterTool).toHaveLength(2);
    expect(written.hooks.AfterTool[0].hooks[0].command).toContain("gsd-context-monitor");
    expect(written.hooks.AfterTool[1].hooks[0].name).toBe("ctx-memory-after-tool");
  });

  it("is idempotent — running twice does not duplicate AfterTool entries", () => {
    writeGeminiHooks(tmpDir);
    writeGeminiHooks(tmpDir);

    const written = JSON.parse(readFileSync(join(tmpDir, "settings.json"), "utf8"));
    expect(written.hooks.AfterTool).toHaveLength(1);
  });
});

// ─── writeOpenCodeHooks ───────────────────────────────────────────────────────

describe("writeOpenCodeHooks", () => {
  it("creates a global OpenCode plugin when it does not exist", () => {
    writeOpenCodeHooks(tmpDir);

    const written = readFileSync(join(tmpDir, "plugins", "ctx-memory.js"), "utf8");
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
    expect(readFileSync(join(tmpDir, "plugins", "ctx-memory.js"), "utf8")).toContain("CTXMemoryPlugin");
  });
});
