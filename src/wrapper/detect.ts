// Detects which LLM tool this wrapper was invoked as.
// Reads process.argv[1] basename — must be a known tool name.

import { basename } from "node:path";
import type { ToolName } from "../types/index.js";

const KNOWN_TOOLS: ReadonlySet<string> = new Set(["claude", "codex", "gemini", "opencode"]);

export function detectTool(): ToolName {
  const script = process.argv[1];
  if (!script) throw new Error("[llm-memory] Cannot detect tool: process.argv[1] is undefined");

  const name = basename(script);
  if (!KNOWN_TOOLS.has(name)) {
    throw new Error(`[llm-memory] Unknown tool '${name}' — wrapper only supports: ${[...KNOWN_TOOLS].join(", ")}`);
  }

  return name as ToolName;
}
