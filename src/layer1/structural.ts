// Pure structural feature extraction — no side effects, no I/O.
// Runs on every message in a conversation; must stay fast.

import type { Message, StructuralFeatures } from "../types/index.js";

// ─── Compiled regexes (module-level — compiled once) ─────────────────────────

const RE_CODE_BLOCK = /```/;
const RE_FILE_PATH = /[./\\][\w./\\]+\.\w{1,6}/;
const RE_URL = /https?:\/\//;
const RE_SENTENCE_SPLIT = /[.!?]+/;
const RE_SHORT_CONFIRMATION = /^(yes|no|ok|okay|sure|good|great|perfect|done|looks good|that works|correct|exactly|right|nope)$/i;

const IMPERATIVE_VERBS =
  /^(fix|add|create|update|refactor|implement|change|remove|build|run|test|deploy|write|make|use|set|get|delete|install|configure)\b/i;

// ─── Main export ──────────────────────────────────────────────────────────────

export function extractStructuralFeatures(
  message: Message,
  index: number,
  totalMessages: number
): StructuralFeatures {
  const { content, role } = message;

  const sentences = content
    .split(RE_SENTENCE_SPLIT)
    .filter((s) => s.trim().length > 0);

  const firstWord = content.trimStart().split(/\s+/)[0] ?? "";

  return {
    length: content.length,
    hasCodeBlock: RE_CODE_BLOCK.test(content),
    hasFilePath: RE_FILE_PATH.test(content),
    hasUrl: RE_URL.test(content),
    hasError: false,            // populated by a separate error-signal pass
    hasDecisionPhrase: false,   // populated by a separate phrase pass
    hasGoalPhrase: false,       // populated by a separate phrase pass
    questionCount: (content.match(/\?/g) ?? []).length,
    imperativeCount: sentences.filter((s) =>
      IMPERATIVE_VERBS.test(s.trimStart())
    ).length,
    sentenceCount: sentences.length,
    startsWithVerb: IMPERATIVE_VERBS.test(firstWord),
    isShortConfirmation:
      role === "user" &&
      content.trim().length < 30 &&
      RE_SHORT_CONFIRMATION.test(content.trim()),
    positionalWeight: computePositionalWeight(index, totalMessages),
  };
}

// ─── Positional weight ────────────────────────────────────────────────────────

function computePositionalWeight(index: number, total: number): number {
  if (total === 0) return 1.0;
  if (index === 0) return 1.0;
  if (index >= total - 3) return 0.8;
  if (index < total * 0.1) return 0.7;
  return 0.4;
}
