// Layer 1 main combiner — pure function, no I/O, never throws.
// Calls all Layer 1 sub-functions and assembles Layer1Output.

import type {
  Message,
  WeightedMessage,
  MessageType,
  Layer1Output,
} from "../types/index.js";
import { extractStructuralFeatures } from "./structural.js";
import { scoreKeywords, DECISION_SIGNALS } from "./keywords.js";
import { analyzePosition } from "./positional.js";
import { detectPatterns } from "./patterns.js";
import { classifyToolEvent } from "./events.js";
import { extractKeywords } from "./tfidf.js";

// Extract the first clean sentence/paragraph containing a decision signal.
// Skips code blocks, markdown headers, and list items.
function extractDecisionSnippet(content: string): string {
  const segments = content.split(/(?<=[.!?])\s+|\n\n+/);
  for (const segment of segments) {
    const s = segment.trim();
    if (s.length < 10 || s.length > 200) continue;
    if (s.includes("```") || s.startsWith("#") || s.startsWith("-") || s.startsWith("*")) continue;
    if (DECISION_SIGNALS.some(sig => s.toLowerCase().includes(sig.toLowerCase()))) {
      return s.length > 120 ? s.slice(0, 119) + "…" : s;
    }
  }
  // fallback: first non-code, non-header line
  const firstLine = content.split("\n").find(l => {
    const t = l.trim();
    return t.length > 5 && !t.startsWith("#") && !t.startsWith("-") && !t.startsWith("*") && !t.includes("```");
  }) ?? content;
  return firstLine.length > 120 ? firstLine.slice(0, 119) + "…" : firstLine;
}

// ─── RawToolEvent ─────────────────────────────────────────────────────────────

export interface RawToolEvent {
  tool: string;
  args: Record<string, unknown>;
  result: Record<string, unknown>;
  success: boolean;
  timestamp: number;
}

// ─── Weight combining ─────────────────────────────────────────────────────────

function combineWeight(
  positionalWeight: number,
  keywordConfidence: number,
  features: ReturnType<typeof extractStructuralFeatures>,
  role: Message["role"]
): number {
  let structuralBoost = 0;
  if (features.hasCodeBlock) structuralBoost += 0.2;
  if (features.hasFilePath) structuralBoost += 0.15;
  if (features.isShortConfirmation) structuralBoost -= 0.3;
  if (features.startsWithVerb && role === "user") structuralBoost += 0.1;

  const w =
    positionalWeight * 0.3 +
    keywordConfidence * 0.5 +
    structuralBoost * 0.2;

  return Math.min(1, Math.max(0, w));
}

// ─── Type classification ──────────────────────────────────────────────────────

function classifyType(
  index: number,
  role: Message["role"],
  keywordCategory: MessageType,
  features: ReturnType<typeof extractStructuralFeatures>
): MessageType {
  if (index === 0 && role === "user") return "goal";
  if (features.isShortConfirmation) return "noise";
  return keywordCategory;
}

// ─── Main export ──────────────────────────────────────────────────────────────

export function processSession(
  messages: Message[],
  toolEvents: RawToolEvent[]
): Layer1Output {
  const total = messages.length;

  // Steps 1–6: build WeightedMessage[]
  const weightedMessages: WeightedMessage[] = messages.map((msg, i) => {
    const features = extractStructuralFeatures(msg, i, total);
    const keyword = scoreKeywords(msg.content);
    const positionalWeight = analyzePosition(i, total, msg.role);
    const weight = combineWeight(positionalWeight, keyword.confidence, features, msg.role);
    const type = classifyType(i, msg.role, keyword.category, features);
    return { message: msg, weight, type, features };
  });

  // Step 7: detect patterns
  const patterns = detectPatterns(weightedMessages);

  // Step 8: classify tool events
  const events = toolEvents
    .map((e) => classifyToolEvent(e.tool, e.args, e.result, e.success))
    .filter((e): e is NonNullable<typeof e> => e !== null)
    .map((e, i) => ({
      ...e,
      session_id: messages[0]?.session_id ?? ("" as any),
      timestamp: (toolEvents[i]?.timestamp ?? Date.now()) as any,
    }));

  // Step 9: TF-IDF keywords
  const keywords = extractKeywords(weightedMessages);

  // Step 10: goal — first user message typed 'goal', fallback to first high-weight user message
  const goalMsg =
    weightedMessages.find((m) => m.message.role === "user" && m.type === "goal") ??
    weightedMessages.find((m) => m.message.role === "user" && m.weight > 0.5);
  const goal = goalMsg?.message.content ?? null;

  // Step 11: decisions — confirmation pattern extractedDecisions + 'decision' typed messages
  const decisions: string[] = [
    ...patterns
      .filter((p) => p.type === "confirmation" && p.extractedDecision !== null)
      .map((p) => p.extractedDecision!),
    ...weightedMessages
      .filter((m) => m.type === "decision")
      .map((m) => extractDecisionSnippet(m.message.content)),
  ];

  // Step 12: errors — 'error' typed messages + error events
  // Only user messages or short assistant messages (< 300 chars) — avoids dumping long Q&A responses
  const errors: string[] = [
    ...weightedMessages
      .filter((m) => m.type === "error" &&
        (m.message.role === "user" || m.message.content.length < 300))
      .map((m) => m.message.content),
    ...events
      .filter((e) => e.type === "error")
      .map((e) => (e.payload as any).message as string),
  ];

  // Step 13: token count estimate
  const tokenCount = weightedMessages
    .filter((m) => m.weight > 0.5)
    .reduce((sum, m) => sum + Math.ceil(m.message.content.length / 4), 0);

  return {
    session_id: messages[0]?.session_id ?? ("" as any),
    goal,
    weightedMessages,
    events,
    decisions,
    errors,
    keywords,
    patterns,
    tokenCount,
  };
}
