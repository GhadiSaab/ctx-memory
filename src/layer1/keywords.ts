// Keyword dictionaries and scoring — pure function, no I/O.

import type { KeywordScore, MessageType } from "../types/index.js";

// ─── Dictionaries ─────────────────────────────────────────────────────────────

export const DECISION_SIGNALS: readonly string[] = [
  "let's go with", "we'll use", "decided to", "going with",
  "the approach is", "we should use", "instead of", "rather than",
  "switching to", "let's use", "I think we should", "agreed",
  "that makes sense", "good idea", "let's do that",
  // assistant announcement patterns
  "I'll use", "I'm using", "the architecture", "the design is",
  "I've decided", "we're going to use", "I chose", "I'm going with",
  "the solution is", "I implemented", "I added", "I created",
];

export const GOAL_SIGNALS: readonly string[] = [
  "I need", "I want", "can you", "please", "fix", "implement",
  "create", "build", "the problem is", "it should", "we need to",
  "help me", "how do", "make it", "add a", "update the",
];

export const FAILURE_SIGNALS: readonly string[] = [
  "error", "failed", "doesn't work", "not working", "broken",
  "exception", "null pointer", "crash",
  "bug", "unexpected", "TypeError", "SyntaxError", "ReferenceError",
  "cannot find", "module not found", "permission denied",
  "ENOENT", "EACCES", "ECONNREFUSED",
];

export const CONCLUSION_SIGNALS: readonly string[] = [
  "done", "works", "fixed", "perfect", "great", "that's it",
  "looks good", "ship it", "working now", "resolved", "merged",
  "deployed", "all tests pass", "lgtm",
];

// ─── Scoring ──────────────────────────────────────────────────────────────────

const DICTIONARIES: Array<{ category: MessageType; signals: readonly string[] }> = [
  { category: "decision",   signals: DECISION_SIGNALS },
  { category: "goal",       signals: GOAL_SIGNALS },
  { category: "error",      signals: FAILURE_SIGNALS },
  { category: "conclusion", signals: CONCLUSION_SIGNALS },
];

export function scoreKeywords(content: string): KeywordScore {
  const lower = content.toLowerCase();

  let bestCategory: MessageType = "noise";
  let bestMatches: string[] = [];
  let bestCount = 0;
  let bestDictSize = 1; // avoid division by zero

  for (const { category, signals } of DICTIONARIES) {
    const matched = signals.filter((phrase) => lower.includes(phrase.toLowerCase()));
    if (matched.length > bestCount) {
      bestCount = matched.length;
      bestCategory = category;
      bestMatches = matched;
      bestDictSize = signals.length;
    }
  }

  if (bestCount === 0) {
    return { category: "noise", confidence: 0, matchedSignals: [] };
  }

  return {
    category: bestCategory,
    confidence: Math.min(bestCount / bestDictSize, 1.0),
    matchedSignals: bestMatches,
  };
}
