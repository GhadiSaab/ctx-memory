// Detects which LLM tool this wrapper was invoked as.
// Reads process.argv[1] basename — must be a known tool name.

import { basename } from "node:path";

export type WrapperToolName = "claude" | "codex" | "gemini" | "opencode";

const KNOWN_TOOLS = new Set<WrapperToolName>(["claude", "codex", "gemini", "opencode"]);

function isWrapperToolName(value: string): value is WrapperToolName {
  return KNOWN_TOOLS.has(value as WrapperToolName);
}

export function detectTool(): WrapperToolName {
  const script = process.argv[1];
  if (!script) throw new Error("[ctx-memory] Cannot detect tool: process.argv[1] is undefined");

  const name = basename(script);
  if (!isWrapperToolName(name)) {
    throw new Error(`[ctx-memory] Unknown tool '${name}' — wrapper only supports: ${[...KNOWN_TOOLS].join(", ")}`);
  }

  return name;
}
