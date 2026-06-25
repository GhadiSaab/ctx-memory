#!/usr/bin/env node
// SessionStart hook — injects project memory as additionalContext.
// Claude Code runs this at session start and injects stdout into the system prompt.

import { getProjectByPathHash } from "../db/index.js";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";

function tryExec(cmd: string, cwd: string): string | null {
  try {
    return execSync(cmd, { cwd, stdio: ["pipe", "pipe", "pipe"] }).toString().trim() || null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const cwd = process.cwd();

  // Try to use the project ID from env (set by the wrapper) first —
  // it's the most reliable reference and avoids redundant resolution.
  const envProjectId = process.env["CTX_MEMORY_PROJECT_ID"] ?? process.env["LLM_MEMORY_PROJECT_ID"];
  let project = envProjectId ? getProjectById(envProjectId as any) : null;

  // Fallback: resolve from cwd if env var didn't yield a project
  if (!project?.memory_doc) {
    const gitRoot = tryExec("git rev-parse --show-toplevel", cwd);
    const resolvedPath = gitRoot ?? cwd;
    const pathHash = createHash("sha256").update(resolvedPath).digest("hex");
    project = getProjectByPathHash(pathHash);
  }

  if (!project?.memory_doc) {
    // No memory yet — nothing to inject
    process.exit(0);
  }

  const output = {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: `<ctx-memory project-memory>\nThe following is context captured automatically from previous coding sessions on this project. Use it as background knowledge:\n${project.memory_doc}\n</ctx-memory>`,
    },
  };

  process.stdout.write(JSON.stringify(output));
  process.exit(0);
}

if (!process.env["VITEST"]) {
  main().catch(() => process.exit(0));
}
