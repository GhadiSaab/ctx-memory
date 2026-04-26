// Layer 3 — project memory merger, serializer, and deserializer.
// Pure functions: no DB calls, no side effects.

import type { Layer2Digest, ProjectMemory, KnownIssue, RecentWorkEntry } from "../types/index.js";
import { randomUUID } from "node:crypto";

// ─── Promotion policy ────────────────────────────────────────────────────────

// Layer 3 is deliberately conservative: it promotes typed facts produced by
// Layer 1/2 instead of re-classifying arbitrary digest strings. Compatibility
// fields such as digest.decisions remain useful for summaries, but they are not
// trusted as project memory unless a fact carries durable provenance.

const TRANSIENT_DECISION_PREFIX = /^(got it|i('|’)ll|i will|i('|’)m|i am|we('|’)ll|we will|let('|’)s|use the|maybe|please|can you|help me|i want|i need|now|next)\b/i;
const TRANSIENT_MEMORY_RE = /\b(?:mcp tool|get_project_memory|retrieve the project memory|store that message|use llm memory|get memory mcp|have the context)\b/i;
const TEST_COMMAND_FILTER_RE = /(?:2>&1|\|\s*(?:tail|head)\b|--runInBand\b|--watch=false\b)\s*(?:-\d+|\d+)?/g;
const TEST_RESULT_RE = /\s+(passed|failed)$/i;

function isUsefulConvention(decision: string): boolean {
  const trimmed = decision.trim();
  if (trimmed.length < 8 || trimmed.length > 220) return false;
  return !TRANSIENT_DECISION_PREFIX.test(trimmed) && !TRANSIENT_MEMORY_RE.test(trimmed);
}

function isUsefulRecentSummary(summary: string, digest: Layer2Digest): boolean {
  const trimmed = summary.trim();
  const lower = trimmed.toLowerCase();
  if (trimmed.length < 6 || trimmed.length > 280) return false;
  if (TRANSIENT_MEMORY_RE.test(trimmed)) return false;
  if (/^(what mcps do you have|no goal detected)$/i.test(trimmed)) return false;
  if (digest.files_modified.length === 0 && digest.validation.length === 0 && digest.errors_encountered.length === 0) {
    const goal = digest.goal?.trim().toLowerCase();
    if (goal && goal === lower) return false;
  }
  return true;
}

function cleanIssueDescription(error: string): string | null {
  const cleaned = error.replace(/\s+/g, " ").trim();
  if (cleaned.length < 8) return null;
  if (TRANSIENT_MEMORY_RE.test(cleaned)) return null;
  return cleaned.length > 220 ? cleaned.slice(0, 219).trimEnd() + "…" : cleaned;
}

function validationCommand(note: string): string | null {
  const trimmed = note.trim();
  const match = trimmed.match(/^(.+?)\s+(passed|failed)$/i);
  if (match?.[2]?.toLowerCase() !== "passed") return null;
  let command = (match ? match[1] : trimmed).trim();
  command = command
    .replace(TEST_COMMAND_FILTER_RE, "")
    .replace(/\s+\|\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!command || /^(tests|build)$/i.test(command)) return null;
  return command;
}

function canonicalValidationCommand(value: string): string | null {
  return validationCommand(`${value.replace(TEST_RESULT_RE, "").trim()} passed`);
}

function factTexts(digest: Layer2Digest, kind: Layer2Digest["facts"][number]["kind"]): string[] {
  return (digest.facts ?? [])
    .filter((fact) => fact.kind === kind)
    .map((fact) => fact.text.trim())
    .filter(Boolean);
}

function typedDecisionTexts(digest: Layer2Digest, category: "architecture" | "convention" | "implementation"): string[] {
  return (digest.facts ?? [])
    .filter((fact): fact is Extract<Layer2Digest["facts"][number], { kind: "decision" }> =>
      fact.kind === "decision" && fact.category === category
    )
    .map((fact) => fact.text.trim())
    .filter(Boolean);
}

function typedIssueTexts(digest: Layer2Digest): string[] {
  const typed = (digest.facts ?? [])
    .filter((fact): fact is Extract<Layer2Digest["facts"][number], { kind: "issue" }> =>
      fact.kind === "issue" && fact.status === "open" && fact.durability !== "transient"
    )
    .map((fact) => fact.text.trim())
    .filter((text) => text && !isFailedValidationIssue(text));
  return typed.length > 0
    ? typed
    : digest.errors_encountered.filter((text) => !isFailedValidationIssue(text));
}

function typedArchitectureTexts(digest: Layer2Digest): string[] {
  return (digest.facts ?? [])
    .filter((fact): fact is Extract<Layer2Digest["facts"][number], { kind: "decision" }> =>
      fact.kind === "decision" &&
      fact.category === "architecture" &&
      fact.durability === "project"
    )
    .map((fact) => fact.text.trim())
    .filter((text) =>
      text.length >= 12 &&
      text.length <= 220 &&
      !TRANSIENT_DECISION_PREFIX.test(text) &&
      !TRANSIENT_MEMORY_RE.test(text)
    );
}

function isFailedValidationIssue(text: string): boolean {
  const trimmed = text.trim();
  if (!/\bfailed$/i.test(trimmed)) return false;
  return canonicalValidationCommand(trimmed) !== null ||
    /\b(?:test|jest|vitest|pytest|mocha|rspec|phpunit|dotnet test|go test|cargo test)\b/i.test(trimmed);
}

function recentWorkSummary(digest: Layer2Digest): string | null {
  if ((digest.facts ?? []).length === 0) return digest.summary;

  const work = factTexts(digest, "work");
  const decisions = typedDecisionTexts(digest, "implementation");
  const validation = digest.validation
    .map(validationCommand)
    .filter((command): command is string => command !== null)
    .slice(0, 1);
  const parts: string[] = [];

  if (digest.files_modified.length > 0) {
    const files = digest.files_modified.length === 1
      ? digest.files_modified[0]
      : digest.files_modified.length === 2
        ? `${digest.files_modified[0]} and ${digest.files_modified[1]}`
        : `${digest.files_modified[0]}, ${digest.files_modified[1]}, and ${digest.files_modified.length - 2} more files`;
    parts.push(`Updated ${files}`);
  } else if (work.length > 0) {
    parts.push(work[0]!);
  } else if (digest.goal) {
    parts.push(digest.goal);
  }

  if (decisions.length > 0) parts.push(decisions[0]!);
  if (validation.length > 0) parts.push(`Validation: ${validation[0]} passed`);
  const joined = parts.join(". ").replace(/\.+/g, ".").trim();
  return joined || digest.summary;
}

const ISSUE_STOPWORDS = new Set([
  "the", "and", "for", "this", "that", "with", "from", "have", "will",
  "are", "was", "were", "been", "has", "had", "not", "but", "what",
  "all", "can", "its", "your", "our", "their", "they", "you", "we",
  "about", "into", "over", "after", "before", "just", "also", "more",
  "some", "any", "yes", "use", "used", "using", "remove", "removed",
  "everything", "related", "moment", "causing", "errors", "error",
  "well", "supported", "codebase", "tests", "cli", "etc",
]);

function issueTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 2 && !ISSUE_STOPWORDS.has(token));
}

function issueResolutionEvidence(digest: Layer2Digest): string {
  return [
    digest.goal ?? "",
    digest.summary ?? "",
    ...digest.decisions,
    ...digest.files_modified,
    ...digest.validation,
    ...digest.keywords,
  ].join("\n");
}

function resolvesKnownIssue(issue: KnownIssue, digest: Layer2Digest): boolean {
  if (digest.outcome !== "completed") return false;

  const description = issue.description.toLowerCase();
  if (digest.keywords.some((kw) => description.includes(kw.toLowerCase()))) {
    return true;
  }

  const evidenceTokens = new Set(issueTokens(issueResolutionEvidence(digest)));
  const descriptionTokens = issueTokens(issue.description);
  if (descriptionTokens.length === 0) return false;

  const meaningfulMatches = descriptionTokens.filter((token) => evidenceTokens.has(token));
  return meaningfulMatches.length >= Math.min(2, descriptionTokens.length);
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
  const summary = recentWorkSummary(digest)?.trim();
  const newEntry: RecentWorkEntry | null = hasSubstantiveWork && summary && isUsefulRecentSummary(summary, digest) ? {
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
    if (resolvesKnownIssue(issue, digest)) {
      return { ...issue, resolved_at: now, resolved_in_session: sessionId as any };
    }
    return issue;
  });

  for (const rawError of typedIssueTexts(digest)) {
    const error = cleanIssueDescription(rawError);
    if (!error) continue;
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
  const typedArch = typedArchitectureTexts(digest);
  for (const decision of typedArch) {
    if (!archSet.has(decision.trim())) {
      archLines.push(decision.trim());
      archSet.add(decision.trim());
    }
  }
  const architecture = archLines.join("\n");

  // ── how_to_test: validation commands observed in successful sessions ──────
  const howToTest: string[] = [];
  const seenTestCommands = new Set<string>();
  for (const existingCommand of existing.how_to_test ?? []) {
    const canonical = canonicalValidationCommand(existingCommand);
    if (canonical && !seenTestCommands.has(canonical)) {
      seenTestCommands.add(canonical);
      howToTest.push(canonical);
    }
  }
  for (const note of [...digest.validation, ...factTexts(digest, "validation")]) {
    const command = validationCommand(note);
    if (command && !seenTestCommands.has(command)) {
      seenTestCommands.add(command);
      howToTest.push(command);
    }
  }
  const trimmedHowToTest = howToTest.slice(-20);

  // ── conventions: useful non-architecture decisions, deduplicated, max 20 ──
  const conventions = [...existing.conventions];
  const conventionCandidates = [
    ...typedDecisionTexts(digest, "convention"),
  ];
  for (const decision of conventionCandidates) {
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
