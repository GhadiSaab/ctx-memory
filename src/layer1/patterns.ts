// Conversation pattern detector — pure function, no I/O, never throws.

import type { WeightedMessage, ConversationPattern } from "../types/index.js";
import { DECISION_SIGNALS } from "./keywords.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Extract the first file path found in a message's content, or null. */
function extractFilePath(content: string): string | null {
  const match = content.match(/[./\\][\w./\\]+\.\w{1,6}/);
  return match ? match[0] : null;
}

/** Truncate a string for use in a summary. */
function truncate(s: string, max = 80): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

/**
 * Extract a short decision statement from a long assistant message.
 * Finds the first sentence/paragraph that contains a decision signal and is under 150 chars.
 * Skips segments with code blocks or markdown headers.
 * Falls back to null if no good sentence found (better to skip than dump garbage).
 */
function extractDecisionFromMessage(content: string): string | null {
  // Split on sentence endings AND paragraph breaks
  const segments = content.split(/(?<=[.!?])\s+|\n\n+/);
  for (const segment of segments) {
    const s = segment.trim();
    // Skip: too short, too long, contains code blocks or markdown headers
    if (s.length < 10 || s.length > 150) continue;
    if (s.includes("```") || s.startsWith("#") || s.startsWith("-") || s.startsWith("*")) continue;
    if (DECISION_SIGNALS.some(sig => s.toLowerCase().includes(sig.toLowerCase()))) {
      return s;
    }
  }
  return null;
}

// ─── Pattern detectors ────────────────────────────────────────────────────────

/**
 * confirmation: assistant message (length > 200, weight > 0.6)
 * immediately followed by a user short-confirmation.
 */
function tryConfirmation(
  messages: WeightedMessage[],
  i: number,
  used: Set<number>
): ConversationPattern | null {
  if (used.has(i)) return null;

  const cur = messages[i];
  const next = messages[i + 1];
  if (!next) return null;

  if (
    cur.message.role === "assistant" &&
    cur.features.length > 200 &&
    cur.weight > 0.6 &&
    next.message.role === "user" &&
    next.features.isShortConfirmation &&
    !used.has(i + 1)
  ) {
    const decision = extractDecisionFromMessage(cur.message.content);
    // Don't create a decision entry if we can't extract a meaningful one
    if (decision === null) return null;
    return {
      type: "confirmation",
      messageIndexes: [i, i + 1],
      extractedDecision: decision,
      confidence: 1.0,
      summary: `Assistant proposed a solution; user confirmed with "${next.message.content.trim()}"`,
    };
  }

  return null;
}

/**
 * error_retry: a message with type 'error', followed within 3 messages
 * by a 'conclusion' type or a high-weight assistant message.
 */
function tryErrorRetry(
  messages: WeightedMessage[],
  i: number,
  used: Set<number>
): ConversationPattern | null {
  if (used.has(i)) return null;

  const cur = messages[i];
  if (cur.type !== "error") return null;

  for (let j = i + 1; j <= Math.min(i + 3, messages.length - 1); j++) {
    if (used.has(j)) continue;
    const candidate = messages[j];
    const isResolution =
      candidate.type === "conclusion" ||
      (candidate.message.role === "assistant" && candidate.weight > 0.6);

    if (isResolution) {
      const distance = j - i;
      return {
        type: "error_retry",
        messageIndexes: [i, j],
        extractedDecision: null,
        confidence: distance === 1 ? 1.0 : 0.7,
        summary: `Tried "${truncate(cur.message.content, 50)}", resolved by "${truncate(candidate.message.content, 50)}"`,
      };
    }
  }

  return null;
}

/**
 * iteration: the same file path appears in 3+ consecutive high-weight
 * messages. Keeps only the last occurrence as the signal.
 */
function tryIteration(
  messages: WeightedMessage[],
  i: number,
  used: Set<number>
): ConversationPattern | null {
  if (used.has(i)) return null;

  const filePath = extractFilePath(messages[i].message.content);
  if (!filePath) return null;
  if (messages[i].weight < 0.5) return null;

  const run: number[] = [i];

  for (let j = i + 1; j < messages.length && j <= i + 10; j++) {
    if (used.has(j)) break;
    const m = messages[j];
    const mPath = extractFilePath(m.message.content);
    if (mPath === filePath && m.weight >= 0.5) {
      run.push(j);
    } else {
      break; // must be consecutive
    }
  }

  if (run.length < 3) return null;

  return {
    type: "iteration",
    messageIndexes: run,
    extractedDecision: null,
    confidence: 1.0,
    summary: `Repeated editing of "${filePath}" across ${run.length} messages`,
  };
}

/**
 * struggle: 3+ consecutive user messages with similar length and
 * low-weight assistant messages between them.
 */
function tryStruggle(
  messages: WeightedMessage[],
  i: number,
  used: Set<number>
): ConversationPattern | null {
  if (used.has(i)) return null;
  if (messages[i].message.role !== "user") return null;

  const baseLength = messages[i].features.length;
  const participating: number[] = [i];
  let userCount = 1;

  for (let j = i + 1; j < messages.length; j++) {
    if (used.has(j)) break;
    const m = messages[j];

    if (m.message.role === "assistant") {
      // Allow a low-weight assistant message between user turns
      if (m.weight > 0.5) break;
      participating.push(j);
    } else {
      // user message — must have similar length (within 50% of base)
      const lenRatio = m.features.length / (baseLength || 1);
      if (lenRatio < 0.5 || lenRatio > 2.0) break;
      participating.push(j);
      userCount++;
    }
  }

  if (userCount < 3) return null;

  return {
    type: "struggle",
    messageIndexes: participating,
    extractedDecision: null,
    confidence: 1.0,
    summary: `${userCount} similar-length user messages with low-weight assistant responses — agent not making progress`,
  };
}

// ─── Main export ──────────────────────────────────────────────────────────────

export function detectPatterns(messages: WeightedMessage[]): ConversationPattern[] {
  const patterns: ConversationPattern[] = [];
  const used = new Set<number>(); // each message index can only match once

  const detectors = [tryConfirmation, tryErrorRetry, tryIteration, tryStruggle];

  for (let i = 0; i < messages.length; i++) {
    for (const detect of detectors) {
      const pattern = detect(messages, i, used);
      if (pattern) {
        patterns.push(pattern);
        for (const idx of pattern.messageIndexes) used.add(idx);
        break; // first match wins for index i
      }
    }
  }

  return patterns;
}
