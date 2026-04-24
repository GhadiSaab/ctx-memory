// Hook config writers — read existing config, deep-merge hook entries, write back.
// Never overwrites unrelated user config keys.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export { buildClaudeHookConfig } from "./claude.js";
export type { ClaudeHookConfig } from "./claude.js";
export { buildGeminiHookConfig } from "./gemini.js";
export type { GeminiHookConfig } from "./gemini.js";
export { buildOpenCodeHookConfig } from "./opencode.js";
export type { OpenCodeHookConfig } from "./opencode.js";

import { buildClaudeHookConfig } from "./claude.js";
import { buildGeminiHookConfig } from "./gemini.js";
import { buildOpenCodeHookConfig } from "./opencode.js";

// ─── JSON file helpers ────────────────────────────────────────────────────────

function readJson(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) return {};
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeJson(filePath: string, data: unknown): void {
  writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

// ─── writeClaudeHooks ─────────────────────────────────────────────────────────

/**
 * Merges llm-memory hooks into .claude/settings.json.
 * @param claudeDir  path to the .claude/ directory (e.g. ~/.claude or <project>/.claude)
 */
export function writeClaudeHooks(claudeDir: string, sessionStartBin: string): void {
  const filePath = join(claudeDir, "settings.json");
  const existing = readJson(filePath);
  const hookConfig = buildClaudeHookConfig(sessionStartBin);

  // Deep-merge: preserve existing hooks sections, add ours if absent
  const existingHooks = (existing["hooks"] ?? {}) as Record<string, unknown>;

  const mergedStart = mergeClaudeHookArray(
    existingHooks["SessionStart"],
    hookConfig.hooks.SessionStart
  );

  const mergedPost = mergeClaudeHookArray(
    existingHooks["PostToolUse"],
    hookConfig.hooks.PostToolUse
  );

  const merged = {
    ...existing,
    hooks: {
      ...existingHooks,
      SessionStart: mergedStart,
      PostToolUse: mergedPost,
    },
  };

  writeJson(filePath, merged);
}

/** Merge our hook entry into the existing array, deduplicating by command string. */
function mergeClaudeHookArray(
  existing: unknown,
  additions: Array<{ matcher?: string; hooks: Array<{ type: string; command: string }> }>
): unknown[] {
  const arr = Array.isArray(existing) ? (existing as unknown[]) : [];

  for (const addition of additions) {
    const ourCmd = addition.hooks[0]?.command;
    // Only add if none of the existing entries already contain our command
    const alreadyPresent = arr.some((entry) => {
      if (typeof entry !== "object" || entry === null) return false;
      const e = entry as Record<string, unknown>;
      const hooks = e["hooks"];
      return Array.isArray(hooks) &&
        hooks.some((h) => typeof h === "object" && h !== null && (h as Record<string, unknown>)["command"] === ourCmd);
    });
    if (!alreadyPresent) {
      arr.push(addition);
    }
  }

  return arr;
}

// ─── writeGeminiHooks ─────────────────────────────────────────────────────────

/**
 * Merges llm-memory hooks into ~/.gemini/settings.json.
 * Uses Gemini's array hook format; preserves existing AfterTool entries.
 * @param geminiDir  path to the ~/.gemini directory
 */
export function writeGeminiHooks(geminiDir: string): void {
  const filePath = join(geminiDir, "settings.json");
  const existing = readJson(filePath);
  const hookConfig = buildGeminiHookConfig();

  const existingHooks = (typeof existing["hooks"] === "object" && existing["hooks"] !== null)
    ? (existing["hooks"] as Record<string, unknown>)
    : {};

  const mergedAfterTool = mergeGeminiHookArray(
    existingHooks["AfterTool"],
    hookConfig.hooks.AfterTool
  );

  const merged = {
    ...existing,
    hooks: {
      ...existingHooks,
      AfterTool: mergedAfterTool,
    },
  };

  writeJson(filePath, merged);
}

/**
 * Merges our AfterTool matcher entries into the existing array.
 * Deduplicates by hook name so setup is idempotent.
 */
function mergeGeminiHookArray(
  existing: unknown,
  additions: Array<{ matcher: string; hooks: Array<{ name: string; type: string; command: string; timeout: number }> }>
): unknown[] {
  const arr = Array.isArray(existing) ? (existing as unknown[]) : [];

  for (const addition of additions) {
    const ourName = addition.hooks[0]?.name;
    const alreadyPresent = arr.some((entry) => {
      if (typeof entry !== "object" || entry === null) return false;
      const e = entry as Record<string, unknown>;
      const hooks = e["hooks"];
      return Array.isArray(hooks) &&
        hooks.some((h) => typeof h === "object" && h !== null && (h as Record<string, unknown>)["name"] === ourName);
    });
    if (!alreadyPresent) {
      arr.push(addition);
    }
  }

  return arr;
}

// ─── writeOpenCodeHooks ───────────────────────────────────────────────────────

/**
 * Writes the llm-memory OpenCode plugin into ~/.config/opencode/plugins.
 * @param openCodeDir  path to the OpenCode config directory
 */
export function writeOpenCodeHooks(openCodeDir: string): void {
  const hookConfig = buildOpenCodeHookConfig();
  const pluginPath = join(openCodeDir, hookConfig.pluginPath);

  mkdirSync(join(openCodeDir, "plugins"), { recursive: true });
  writeFileSync(pluginPath, hookConfig.content, "utf8");
}
