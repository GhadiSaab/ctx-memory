// Layer 2 digest generator — pure transformation, no I/O, never throws.

import type { Layer1Output, Layer2Digest } from "../types/index.js";
import type { SessionOutcome } from "../types/index.js";
import { randomUUID } from "node:crypto";

// ─── Token budget ─────────────────────────────────────────────────────────────

const BUDGET = 500;

function estimateTokens(digest: Omit<Layer2Digest, "id" | "session_id" | "created_at">): number {
  return Math.ceil(JSON.stringify(digest).length / 4);
}

function cleanText(value: string | null | undefined, max = 180): string | null {
  if (!value) return null;
  const cleaned = value
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned || cleaned === "No goal detected") return null;
  return cleaned.length > max ? cleaned.slice(0, max - 1).trimEnd() + "…" : cleaned;
}

function conciseGoal(goal: string | null): string | null {
  const cleaned = cleanText(goal, 220);
  if (!cleaned) return null;

  const lower = cleaned.toLowerCase();
  if (lower.includes("layer 3") && lower.includes("memory")) {
    return "Improve Layer 3 project memory quality";
  }

  const split = cleaned
    .split(/(?:\.|\?|!|\bother than that\b|\band then\b|\balso\b)/i)
    .map((part) => cleanText(part, 120))
    .find((part): part is string => part !== null && part.length >= 12);

  return split ?? cleanText(cleaned, 120);
}

function summarizeFiles(files: string[]): string | null {
  if (files.length === 0) return null;
  if (files.length === 1) return files[0]!;
  if (files.length === 2) return `${files[0]} and ${files[1]}`;
  return `${files[0]}, ${files[1]}, and ${files.length - 2} more files`;
}

function collectValidation(layer1: Layer1Output): string[] {
  const validation: string[] = [];
  const seen = new Set<string>();

  for (const event of layer1.events ?? []) {
    const payload = event.payload as any;
    let note: string | null = null;

    if (event.type === "test_run") {
      const command = cleanText(payload.command, 80);
      const result = payload.failed > 0 ? "failed" : "passed";
      note = command ? `${command} ${result}` : `Tests ${result}`;
    } else if (event.type === "build_attempt") {
      const command = cleanText(payload.command, 80);
      const result = payload.success ? "passed" : "failed";
      note = command ? `${command} ${result}` : `Build ${result}`;
    }

    if (note && !seen.has(note)) {
      seen.add(note);
      validation.push(note);
    }
  }

  return validation;
}

function buildSummary(
  goal: string | null,
  files: string[],
  decisions: string[],
  errors: string[],
  validation: string[],
  outcome: SessionOutcome
): string | null {
  const focus = conciseGoal(goal) ?? cleanText(decisions[0], 120);
  const fileSummary = summarizeFiles(files);

  if (!focus && !fileSummary && decisions.length === 0 && errors.length === 0 && validation.length === 0) {
    return null;
  }

  const parts: string[] = [];
  if (fileSummary) {
    parts.push(focus ? `Updated ${fileSummary} to ${focus[0]!.toLowerCase()}${focus.slice(1)}` : `Updated ${fileSummary}`);
  } else if (focus) {
    parts.push(outcome === "completed" ? focus : `Worked on ${focus[0]!.toLowerCase()}${focus.slice(1)}`);
  }

  if (!fileSummary && decisions.length > 0) {
    const decision = cleanText(decisions[0], 120);
    if (decision && decision !== focus) parts.push(decision);
  }

  if (errors.length > 0) {
    const error = cleanText(errors[0], 100);
    if (error) parts.push(`Encountered ${error}`);
  }

  if (validation.length > 0) {
    parts.push(`Validation: ${validation.slice(0, 2).join("; ")}`);
  }

  return cleanText(parts.join(". "), 220);
}

// ─── Main export ──────────────────────────────────────────────────────────────

export function generateDigest(
  layer1: Layer1Output,
  outcome: SessionOutcome,
  exitCode: number | null
): Layer2Digest {
  try {
    // goal
    const goal =
      layer1.goal ??
      layer1.decisions[0] ??
      "No goal detected";

    // files_modified — deduplicated paths from file_created | file_modified events
    const seenPaths = new Set<string>();
    const filesModified: string[] = [];
    for (const e of layer1.events ?? []) {
      if (e.type === "file_created" || e.type === "file_modified") {
        const path = (e.payload as any).path as string;
        if (path && !seenPaths.has(path)) {
          seenPaths.add(path);
          filesModified.push(path);
        }
      }
    }

    let decisions = [...(layer1.decisions ?? [])];
    let errors = [...(layer1.errors ?? [])];
    let keywords = [...(layer1.keywords ?? [])];
    let files = [...filesModified];
    let goalStr = goal;
    let validation = collectValidation(layer1);
    let summary = buildSummary(goalStr, files, decisions, errors, validation, outcome);

    // Token budget enforcement
    const makeDraft = (g: string, s: string | null, fi: string[], d: string[], e: string[], v: string[], k: string[]) => ({
      goal: g, summary: s, files_modified: fi, decisions: d, errors_encountered: e,
      validation: v, keywords: k, outcome, estimated_tokens: 0,
    });

    let tokens = estimateTokens(makeDraft(goalStr, summary, files, decisions, errors, validation, keywords));

    if (tokens > BUDGET) {
      decisions = decisions.slice(0, 5).map(d => d.length > 120 ? d.slice(0, 120) + "…" : d);
      errors = errors.slice(0, 3).map(e => e.length > 120 ? e.slice(0, 120) + "…" : e);
      files = files.slice(0, 10);
      validation = validation.slice(0, 5);
      keywords = keywords.slice(0, 10);
      summary = buildSummary(goalStr, files, decisions, errors, validation, outcome);
      tokens = estimateTokens(makeDraft(goalStr, summary, files, decisions, errors, validation, keywords));

      if (tokens > BUDGET) {
        goalStr = goalStr.length > 150 ? goalStr.slice(0, 149) + "…" : goalStr;
        decisions = decisions.slice(0, 3).map(d => d.length > 80 ? d.slice(0, 80) + "…" : d);
        errors = errors.slice(0, 2).map(e => e.length > 80 ? e.slice(0, 80) + "…" : e);
        summary = buildSummary(goalStr, files, decisions, errors, validation, outcome);
        tokens = estimateTokens(makeDraft(goalStr, summary, files, decisions, errors, validation, keywords));
      }
    }

    return {
      id: randomUUID() as any,
      session_id: layer1.session_id,
      goal: goalStr,
      summary,
      files_modified: files,
      decisions,
      errors_encountered: errors,
      validation,
      outcome,
      keywords,
      estimated_tokens: tokens,
      created_at: Date.now() as any,
    };
  } catch {
    // Minimal valid digest for crashed/malformed sessions
    return {
      id: randomUUID() as any,
      session_id: layer1?.session_id ?? ("" as any),
      goal: "No goal detected",
      summary: null,
      files_modified: [],
      decisions: [],
      errors_encountered: [],
      validation: [],
      outcome,
      keywords: [],
      estimated_tokens: 0,
      created_at: Date.now() as any,
    };
  }
}
