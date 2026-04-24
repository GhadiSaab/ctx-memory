// Gemini CLI hook config generator.
// Produces the hooks block for ~/.gemini/settings.json using Gemini's array format.

import { homedir } from "node:os";
import { join } from "node:path";

const RECEIVER = join(homedir(), ".llm-memory", "bin", "hook-receiver");

const HOOK_CMD = (event: string) =>
  `${RECEIVER} --event ${event} --session $LLM_MEMORY_SESSION_ID`;

export interface GeminiHookEntry {
  name: string;
  type: "command";
  command: string;
  timeout: number;
}

export interface GeminiHookMatcher {
  matcher: string;
  hooks: GeminiHookEntry[];
}

export interface GeminiHookConfig {
  hooks: {
    AfterTool: GeminiHookMatcher[];
  };
}

export function buildGeminiHookConfig(): GeminiHookConfig {
  return {
    hooks: {
      AfterTool: [
        {
          matcher: ".*",
          hooks: [
            {
              name: "llm-memory-after-tool",
              type: "command",
              command: HOOK_CMD("PostToolUse"),
              timeout: 5000,
            },
          ],
        },
      ],
    },
  };
}
