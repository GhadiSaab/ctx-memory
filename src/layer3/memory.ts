// Layer 3 — project memory merger, serializer, and deserializer.
// Pure functions: no DB calls, no side effects.

import type { Layer2Digest, ProjectMemory, KnownIssue, RecentWorkEntry } from "../types/index.js";
import { randomUUID } from "node:crypto";

// ─── Architecture keyword detection ───────────────────────────────────────────

// Architecture notes describe durable stack/design facts, not transient plans.
const ARCH_SIGNALS = [
  "we use ", "uses ", "is backed by ", "is stored ", "stored at ",
  "registered in ", "reads ", "writes ", "resolves ", "switched to ", "chose ",
  "the architecture", "the stack", "the design",
  "instead of ", "rather than ",
  "react", "vue", "angular", "next", "svelte",
  "node", "deno", "bun", "python", "go ", "rust", "java",
  "postgres", "mysql", "sqlite", "mongodb", "redis",
  "graphql", "rest", "grpc", "websocket",
  "docker", "kubernetes", "terraform",
  "typescript", "javascript", "tailwind", "prisma",
];

const TRANSIENT_DECISION_PREFIX = /^(i('|’)ll|i will|i('|’)m|we('|’)ll|we will|let('|’)s|use the|maybe|please|can you|help me|i want|i need)\b/i;

function isArchitectureNote(decision: string): boolean {
  const trimmed = decision.trim();
  const lower = trimmed.toLowerCase();
  if (trimmed.length < 12 || trimmed.length > 220) return false;
  if (TRANSIENT_DECISION_PREFIX.test(trimmed)) return false;
  if (lower.includes("mcp tool") || lower.includes("subagent-driven approach")) return false;
  return ARCH_SIGNALS.some((kw) => lower.includes(kw));
}

function isUsefulConvention(decision: string): boolean {
  const trimmed = decision.trim();
  if (trimmed.length < 8 || trimmed.length > 220) return false;
  return !TRANSIENT_DECISION_PREFIX.test(trimmed);
}

function validationCommand(note: string): string | null {
  const trimmed = note.trim();
  const match = trimmed.match(/^(.+?)\s+(passed|failed)$/i);
  const command = (match ? match[1] : trimmed).trim();
  if (!command || /^(tests|build)$/i.test(command)) return null;
  return command;
}

// ─── mergeIntoProjectMemory ───────────────────────────────────────────────────

export function mergeIntoProjectMemory(
  existing: ProjectMemory,
  digest: Layer2Digest,
  sessionId: string
): ProjectMemory {
  const now = Date.now() as any;

  // ── recent_work: prepend substantive work summaries, keep last 10 ─────────
  const hasSubstantiveWork =
    digest.files_modified.length > 0 ||
    digest.decisions.length > 0 ||
    digest.errors_encountered.length > 0 ||
    digest.validation.length > 0;
  const summary = digest.summary?.trim();
  const newEntry: RecentWorkEntry | null = hasSubstantiveWork && summary ? {
    id: randomUUID() as any,
    project_id: existing.project_id,
    session_id: sessionId as any,
    summary,
    date: now,
  } : null;
  const recentWork = (newEntry ? [newEntry, ...existing.recent_work] : existing.recent_work).slice(0, 10);

  // ── known_issues: add new, resolve matching on completion ─────────────────
  const knownIssues: KnownIssue[] = existing.known_issues.map((issue) => {
    if (issue.resolved_at !== null) return issue; // already resolved
    if (
      digest.outcome === "completed" &&
      digest.keywords.some((kw) => issue.description.toLowerCase().includes(kw.toLowerCase()))
    ) {
      return { ...issue, resolved_at: now, resolved_in_session: sessionId as any };
    }
    return issue;
  });

  for (const error of digest.errors_encountered) {
    const alreadyKnown = knownIssues.some((issue) =>
      issue.description.includes(error) || error.includes(issue.description)
    );
    if (!alreadyKnown) {
      knownIssues.push({
        id: randomUUID() as any,
        project_id: existing.project_id,
        description: error,
        detected_at: now,
        resolved_at: null,
        resolved_in_session: null,
      });
    }
  }

  // ── architecture: append architecture-note decisions (no duplicates) ───────
  const existingLines = existing.architecture
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const archLines = [...existingLines];
  const archSet = new Set(archLines);
  for (const decision of digest.decisions) {
    if (isArchitectureNote(decision) && !archSet.has(decision.trim())) {
      archLines.push(decision.trim());
      archSet.add(decision.trim());
    }
  }
  const architecture = archLines.join("\n");

  // ── how_to_test: validation commands observed in successful sessions ──────
  const howToTest = [...(existing.how_to_test ?? [])];
  for (const note of digest.validation) {
    const command = validationCommand(note);
    if (command && !howToTest.includes(command)) howToTest.push(command);
  }
  const trimmedHowToTest = howToTest.slice(-20);

  // ── conventions: useful non-architecture decisions, deduplicated, max 20 ──
  const conventions = [...existing.conventions];
  for (const decision of digest.decisions) {
    if (!archSet.has(decision.trim()) && isUsefulConvention(decision) && !conventions.includes(decision)) {
      conventions.push(decision);
    }
  }
  const trimmedConventions = conventions.slice(-20);

  const updated: ProjectMemory = {
    project_id: existing.project_id,
    memory_doc: "", // filled by serialize below
    architecture,
    how_to_test: trimmedHowToTest,
    conventions: trimmedConventions,
    known_issues: knownIssues,
    recent_work: recentWork,
    updated_at: now,
  };

  updated.memory_doc = serializeMemory(updated);
  return updated;
}

// ─── serializeMemory ──────────────────────────────────────────────────────────

export function serializeMemory(memory: ProjectMemory): string {
  const lines: string[] = [];

  lines.push("# Project Memory");
  lines.push("");

  // Architecture
  lines.push("## Architecture");
  if (memory.architecture.trim()) {
    for (const line of memory.architecture.split("\n").filter(Boolean)) {
      lines.push(`- ${line}`);
    }
  } else {
    lines.push("_No architecture notes yet._");
  }
  lines.push("");

  // How to Test
  lines.push("## How to Test");
  if (memory.how_to_test.length === 0) {
    lines.push("_No test commands recorded yet._");
  } else {
    for (const command of memory.how_to_test) {
      lines.push(`- ${command}`);
    }
  }
  lines.push("");

  // Known Issues
  lines.push("## Known Issues");
  const open = memory.known_issues.filter((i) => i.resolved_at === null);
  const resolved = memory.known_issues.filter((i) => i.resolved_at !== null);
  if (open.length === 0 && resolved.length === 0) {
    lines.push("_No known issues._");
  } else {
    for (const issue of open) {
      lines.push(`- [ ] ${issue.description}`);
    }
    for (const issue of resolved) {
      lines.push(`- [x] ${issue.description}`);
    }
  }
  lines.push("");

  // Conventions
  lines.push("## Conventions");
  if (memory.conventions.length === 0) {
    lines.push("_No conventions recorded yet._");
  } else {
    for (const c of memory.conventions) {
      lines.push(`- ${c}`);
    }
  }
  lines.push("");

  // Recent Work
  lines.push("## Recent Work");
  if (memory.recent_work.length === 0) {
    lines.push("_No recent work._");
  } else {
    for (const entry of memory.recent_work) {
      const date = new Date(entry.date).toISOString().slice(0, 10);
      lines.push(`- [${date}] ${entry.summary}`);
    }
  }

  return lines.join("\n");
}

// ─── deserializeMemory ────────────────────────────────────────────────────────

export function deserializeMemory(doc: string, projectId: string): ProjectMemory {
  const sections: Record<string, string[]> = {};
  let current = "";

  for (const raw of doc.split("\n")) {
    const line = raw.trimEnd();
    if (line.startsWith("## ")) {
      current = line.slice(3).trim();
      sections[current] = [];
    } else if (current && line.startsWith("- ")) {
      sections[current].push(line.slice(2));
    }
  }

  // Architecture
  const archLines = (sections["Architecture"] ?? [])
    .map((l) => l.trim())
    .filter((l) => l !== "_No architecture notes yet._");
  const architecture = archLines.join("\n");

  // How to Test
  const how_to_test = (sections["How to Test"] ?? []).filter(
    (l) => l !== "_No test commands recorded yet._"
  );

  // Conventions
  const conventions = (sections["Conventions"] ?? []).filter(
    (l) => l !== "_No conventions recorded yet._"
  );

  // Known Issues
  const known_issues: KnownIssue[] = (sections["Known Issues"] ?? [])
    .filter((l) => l !== "_No known issues._")
    .map((line) => {
      const resolved = line.startsWith("[x] ");
      const description = line.replace(/^\[.\] /, "");
      return {
        id: randomUUID() as any,
        project_id: projectId as any,
        description,
        detected_at: 0 as any,
        resolved_at: resolved ? (0 as any) : null,
        resolved_in_session: null,
      };
    });

  // Recent Work
  const recent_work: RecentWorkEntry[] = (sections["Recent Work"] ?? [])
    .filter((l) => l !== "_No recent work._")
    .map((line) => {
      const match = line.match(/^\[(\d{4}-\d{2}-\d{2})\] (.+)$/);
      const date = match ? new Date(match[1]).getTime() : 0;
      const summary = match ? match[2] : line;
      return {
        id: randomUUID() as any,
        project_id: projectId as any,
        session_id: "" as any,
        summary,
        date: date as any,
      };
    });

  const memory: ProjectMemory = {
    project_id: projectId as any,
    memory_doc: doc,
    architecture,
    how_to_test,
    conventions,
    known_issues,
    recent_work,
    updated_at: 0 as any,
  };

  return memory;
}
