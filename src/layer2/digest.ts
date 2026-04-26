// Layer 2 digest generator — pure transformation, no I/O, never throws.

import type { ExtractedFact, Layer1Output, Layer2Digest } from "../types/index.js";
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
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned || cleaned === "No goal detected") return null;
  return cleaned.length > max ? cleaned.slice(0, max - 1).trimEnd() + "…" : cleaned;
}

function conciseGoal(goal: string | null): string | null {
  const cleaned = cleanText(goal, 260);
  if (!cleaned) return null;

  const lower = cleaned.toLowerCase();
  if (lower.includes("layer 3") && lower.includes("memory")) {
    return "Improve Layer 3 project memory quality";
  }

  let imperative = cleaned;
  for (let i = 0; i < 3; i++) {
    imperative = imperative
      .replace(/^(can you|could you|please|i want you to|i need you to|let'?s|we need to|help me)\s+/i, "")
      .replace(/^(to|and)\s+/i, "")
      .trim();
  }

  const split = imperative
    .split(/(?:\.|\?|!|\bother than that\b|\band then\b|\balso\b|\bhere is\b)/i)
    .map((part) => cleanText(part, 120))
    .find((part): part is string => part !== null && part.length >= 12);

  return split ?? cleanText(cleaned, 120);
}

function sentenceCase(text: string): string {
  const cleaned = text.trim();
  if (!cleaned) return cleaned;
  return cleaned[0]!.toUpperCase() + cleaned.slice(1);
}

function cleanList(values: string[], maxItems: number, maxChars: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    const cleaned = cleanText(value, maxChars);
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
    if (out.length >= maxItems) break;
  }

  return out;
}

function dedupeFacts(facts: ExtractedFact[]): ExtractedFact[] {
  const out: ExtractedFact[] = [];
  const seen = new Set<string>();
  for (const fact of facts) {
    const text = cleanText(fact.text, fact.kind === "issue" ? 220 : 180);
    if (!text) continue;
    const key = `${fact.kind}:${text.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...fact, text });
  }
  return out;
}

function eventFacts(layer1: Layer1Output): ExtractedFact[] {
  const facts: ExtractedFact[] = [];
  for (const event of layer1.events ?? []) {
    const payload = event.payload as any;
    if (event.type === "file_created" || event.type === "file_modified") {
      facts.push({ kind: "work", text: `Updated ${payload.path}`, source: "tool_event", confidence: 0.9, durability: "session" });
    } else if (event.type === "test_run") {
      const command = payload.command ?? "Tests";
      const result = payload.failed > 0 ? "failed" : "passed";
      facts.push({ kind: "validation", text: `${command} ${result}`, source: "tool_event", confidence: 0.9, durability: "session" });
    } else if (event.type === "build_attempt") {
      const command = payload.command ?? "Build";
      const result = payload.success ? "passed" : "failed";
      facts.push({ kind: "validation", text: `${command} ${result}`, source: "tool_event", confidence: 0.85, durability: "session" });
      if (!payload.success && payload.errorSummary) {
        facts.push({ kind: "issue", text: payload.errorSummary, source: "tool_event", confidence: 0.9, durability: "session", status: "open", evidence: command });
      }
    } else if (event.type === "error") {
      facts.push({ kind: "issue", text: payload.message, source: "tool_event", confidence: 0.9, durability: "session", status: "open", evidence: payload.command ?? undefined });
    }
  }
  return facts;
}

function legacyFacts(layer1: Layer1Output): ExtractedFact[] {
  const facts: ExtractedFact[] = [];
  for (const decision of layer1.decisions ?? []) {
    facts.push({
      kind: "decision",
      text: decision,
      source: "assistant_message",
      confidence: 0.65,
      durability: "session",
      category: /\b(sqlite|postgres|redis|jwt|auth|api|architecture|stack|instead of|rather than)\b/i.test(decision)
        ? "architecture"
        : "implementation",
    });
  }
  for (const error of layer1.errors ?? []) {
    facts.push({
      kind: "issue",
      text: error,
      source: "user_message",
      confidence: 0.7,
      durability: "session",
      status: "open",
    });
  }
  return facts;
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

  for (const fact of layer1.facts ?? []) {
    if (fact.kind === "validation" && !seen.has(fact.text)) {
      seen.add(fact.text);
      validation.push(fact.text);
    }
  }

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
  work: string[],
  decisions: string[],
  errors: string[],
  validation: string[],
  outcome: SessionOutcome
): string | null {
  const focus = conciseGoal(goal) ?? cleanText(decisions[0], 120);
  const fileSummary = summarizeFiles(files);

  if (!focus && !fileSummary && work.length === 0 && decisions.length === 0 && errors.length === 0 && validation.length === 0) {
    return null;
  }

  const parts: string[] = [];
  if (fileSummary) {
    parts.push(focus ? `Goal: ${sentenceCase(focus)}` : "Updated project files");
    parts.push(`Updated ${fileSummary}`);
  } else if (work.length > 0) {
    parts.push(work[0]!);
  } else if (focus) {
    parts.push(outcome === "completed" ? sentenceCase(focus) : `Goal: ${sentenceCase(focus)}`);
  }

  if (decisions.length > 0) {
    const decision = cleanText(decisions[0], 120);
    if (decision && decision !== focus) parts.push(`Decision: ${decision}`);
  }

  if (errors.length > 0) {
    const error = cleanText(errors[0], 100);
    if (error) parts.push(`Issue: ${error}`);
  }

  if (validation.length > 0) {
    parts.push(`Validation: ${validation.slice(0, 2).join("; ")}`);
  }

  const joined = parts.join(". ").replace(/\.+/g, ".");
  return cleanText(joined, 260);
}

// ─── Main export ──────────────────────────────────────────────────────────────

export function generateDigest(
  layer1: Layer1Output,
  outcome: SessionOutcome,
  exitCode: number | null
): Layer2Digest {
  try {
    // goal
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

    let facts = dedupeFacts([...(layer1.facts ?? []), ...legacyFacts(layer1), ...eventFacts(layer1)]);
    let decisions = cleanList(
      facts.filter((fact) => fact.kind === "decision").map((fact) => fact.text),
      8,
      180
    );
    let errors = cleanList(
      facts.filter((fact) => fact.kind === "issue" && (fact as any).status !== "transient").map((fact) => fact.text),
      5,
      180
    );
    const factKeywords = facts.filter((fact) => fact.kind === "keyword").map((fact) => fact.text);
    let keywords = cleanList([...factKeywords, ...(layer1.keywords ?? []), ...decisions, ...errors], 10, 80);
    let files = filesModified.slice(0, 10);
    let work = cleanList(facts.filter((fact) => fact.kind === "work").map((fact) => fact.text), 5, 140);
    let goalStr = conciseGoal(layer1.goal) ?? cleanText(decisions[0], 120) ?? "No goal detected";
    let validation = collectValidation(layer1);
    let summary = buildSummary(goalStr, files, work, decisions, errors, validation, outcome);

    // Token budget enforcement
    const makeDraft = (g: string, s: string | null, fi: string[], d: string[], e: string[], v: string[], k: string[]) => ({
      goal: g, summary: s, files_modified: fi, decisions: d, errors_encountered: e,
      validation: v, facts, keywords: k, outcome, estimated_tokens: 0,
    });

    let tokens = estimateTokens(makeDraft(goalStr, summary, files, decisions, errors, validation, keywords));

    if (tokens > BUDGET) {
      decisions = decisions.slice(0, 5).map(d => d.length > 120 ? d.slice(0, 120) + "…" : d);
      errors = errors.slice(0, 3).map(e => e.length > 120 ? e.slice(0, 120) + "…" : e);
      files = files.slice(0, 10);
      validation = validation.slice(0, 5);
      keywords = keywords.slice(0, 10);
      work = work.slice(0, 3);
      facts = facts.slice(0, 20);
      summary = buildSummary(goalStr, files, work, decisions, errors, validation, outcome);
      tokens = estimateTokens(makeDraft(goalStr, summary, files, decisions, errors, validation, keywords));

      if (tokens > BUDGET) {
        goalStr = goalStr.length > 150 ? goalStr.slice(0, 149) + "…" : goalStr;
        decisions = decisions.slice(0, 3).map(d => d.length > 80 ? d.slice(0, 80) + "…" : d);
        errors = errors.slice(0, 2).map(e => e.length > 80 ? e.slice(0, 80) + "…" : e);
        facts = facts.slice(0, 12);
        summary = buildSummary(goalStr, files, work, decisions, errors, validation, outcome);
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
      facts,
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
      facts: [],
      outcome,
      keywords: [],
      estimated_tokens: 0,
      created_at: Date.now() as any,
    };
  }
}
