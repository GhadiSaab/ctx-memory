#!/usr/bin/env node
// SessionStart hook — injects project memory as additionalContext.
// Claude Code runs this at session start and injects stdout into the system prompt.

import { getProjectByPathHash, getProjectById } from "../db/index.js";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { basename } from "node:path";

function tryExec(cmd: string, cwd: string): string | null {
  try {
    return execSync(cmd, { cwd, stdio: ["pipe", "pipe", "pipe"] }).toString().trim() || null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const cwd = process.cwd();

  // Resolve project from cwd
  const gitRoot = tryExec("git rev-parse --show-toplevel", cwd);
  const resolvedPath = gitRoot ?? cwd;
  const pathHash = createHash("sha256").update(resolvedPath).digest("hex");

  const project = getProjectByPathHash(pathHash);
  if (!project?.memory_doc) {
    // No memory yet — nothing to inject
    process.exit(0);
  }

  const output = {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: `<ctx-memory>\n${project.memory_doc}\n</ctx-memory>`,
    },
  };

  process.stdout.write(JSON.stringify(output));
  process.exit(0);
}

if (!process.env["VITEST"]) {
  main().catch(() => process.exit(0));
}
