// Layer 1 main combiner — pure function, no I/O, never throws.
// Calls all Layer 1 sub-functions and assembles Layer1Output.

import type {
  Message,
  WeightedMessage,
  MessageType,
  Layer1Output,
  ExtractedFact,
  DecisionCategory,
} from "../types/index.js";
import { extractStructuralFeatures } from "./structural.js";
import { scoreKeywords, DECISION_SIGNALS } from "./keywords.js";
import { analyzePosition } from "./positional.js";
import { detectPatterns } from "./patterns.js";
import { classifyToolEvent } from "./events.js";
import { extractKeywords } from "./tfidf.js";

const DURABLE_DECISION_SIGNALS = [
  "decided to", "chose", "switching to", "switched to", "going with",
  "the approach is", "the architecture", "the design is", "the stack",
  "is backed by", "is stored", "stored at",
  "instead of", "rather than",
];

const MEMORY_LOOKUP_RE = /\b(?:mcp tool|retrieve the project memory|get_project_memory|store that message|use llm memory|get memory mcp)\b/i;
const TRANSIENT_DECISION_RE = /\b(?:i'?ll check|i'?ll inspect|i am going to|i'?m going to)\b/i;

const ERROR_LINE_RE = /\b(error|failed|failure|exception|traceback|typeerror|syntaxerror|referenceerror|enoent|eacces|econnrefused|cannot find|module not found|permission denied|timed out|timeout|crash(?:ed)?)\b/i;
const SCRATCH_WORK_RE = /\b(now i need|now let me|let me|i'?ll update|i'?ll add|i need to update|also add a test|next i|i should|need to cover|base directory for this skill|#\s+\w+)/i;
const SCAFFOLDING_RE = /\b(?:superpowers:[\w-]+|using tdd|test-driven[- ]development|red green refactor|red phase|green phase|refactor phase|\*\*red\*\*|\*\*green\*\*|\*\*refactor\*\*)\b/i;
const SESSION_OBSERVATION_RE = /\b(?:bug|issue|error|test|build)\s+(?:must have|appears to have|seems to have|was already|is already|had been)\b|\bmust have been fixed\b/i;
const PRESENTATION_HEADER_RE = /^(?:here(?:'|’)s|here is)\s+(?:what\s+)?(?:changed|i changed|was changed|the fix|the summary)\s*:?\s*$/i;
const IMPLEMENTATION_RE = /\b(implemented|added|updated|fixed|changed|created|wired|handled|guarded|parsed|introduced|refactored|modified)\b/i;
const CONVENTION_RE = /\b(always|never|prefer|keep|must|should|convention|use .+ imports|do not|don't)\b/i;
const PROCESS_TERMS = new Set([
  "test", "tests", "testing", "coverage", "validation", "failing", "failed",
  "pass", "passing", "todo",
]);
const ARCH_DOMAIN_TERMS = new Set([
  "auth", "authentication", "jwt", "oauth", "session", "sessions", "token",
  "tokens", "cookie", "cookies", "httponly", "refresh",
  "persistence", "storage", "cache", "database", "schema", "sqlite",
  "postgres", "mysql", "mongodb", "redis", "prisma",
  "api", "protocol", "integration", "mcp", "rest", "graphql", "grpc",
  "websocket", "pipeline", "middleware", "wrapper", "data",
  "deployment", "runtime", "framework", "agent", "react", "vue", "angular",
  "next", "svelte", "node", "deno", "bun", "python", "go", "rust", "java",
  "typescript", "javascript",
]);
const ARCH_RELATION_TERMS = new Set([
  "use", "uses", "using", "with", "backed", "stored", "registered", "reads",
  "writes", "resolves", "switched", "chose", "architecture", "stack",
  "design", "instead", "rather", "strategy",
]);
const PROCESS_ACTION_TERMS = new Set([
  "need", "needs", "updated", "update", "added", "add", "cover", "covers",
  "match", "matches", "run", "runs", "pass", "passes", "passing",
]);

function cleanSnippet(content: string, max = 160): string | null {
  const cleaned = content
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;
  return cleaned.length > max ? cleaned.slice(0, max - 1).trimEnd() + "…" : cleaned;
}

function cleanDecisionCandidate(content: string): string | null {
  const cleaned = cleanSnippet(content, 180);
  if (!cleaned) return null;
  const stripped = cleaned
    .replace(/^(?:here(?:'|’)s|here is)\s+(?:what\s+)?(?:changed|i changed|was changed|the fix|the summary)\s*:?\s*/i, "")
    .replace(/^(?:architecture\s+uses?\s+){2,}/i, "Architecture uses ")
    .replace(/^\*{0,2}(red|green|refactor)\*{0,2}\s*:?\s*/i, "")
    .replace(/^using\s+tdd\s+to\s+/i, "")
    .trim();
  if (!stripped || stripped.length < 8) return null;
  return stripped.length > 160 ? stripped.slice(0, 159).trimEnd() + "…" : stripped;
}

function factKey(fact: ExtractedFact): string {
  return `${fact.kind}:${fact.text.toLowerCase()}`;
}

function addFact(facts: ExtractedFact[], seen: Set<string>, fact: ExtractedFact): void {
  const cleaned = cleanSnippet(fact.text, fact.kind === "issue" ? 220 : 180);
  if (!cleaned) return;
  const normalized = { ...fact, text: cleaned };
  const key = factKey(normalized);
  if (!seen.has(key)) {
    seen.add(key);
    facts.push(normalized);
  }
}

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function isDurableArchitectureFact(text: string): boolean {
  const terms = tokens(text);

  const domainHits = new Set(terms.filter((term) => ARCH_DOMAIN_TERMS.has(term)));
  if (domainHits.size === 0) return false;

  const relationHits = terms.some((term) => ARCH_RELATION_TERMS.has(term));
  return domainHits.size >= 2 || relationHits;
}

function isProcessOnlyStatement(text: string): boolean {
  const terms = tokens(text);
  const processHit = terms.some((term) => PROCESS_TERMS.has(term));
  const actionHit = terms.some((term) => PROCESS_ACTION_TERMS.has(term));
  return processHit && actionHit && !isDurableArchitectureFact(text);
}

function classifyDecision(text: string): DecisionCategory {
  if (CONVENTION_RE.test(text)) return "convention";
  if (isDurableArchitectureFact(text)) return "architecture";
  return "implementation";
}

function isDecisionLike(text: string): boolean {
  if (MEMORY_LOOKUP_RE.test(text)) return false;
  if (SCAFFOLDING_RE.test(text)) return false;
  if (SESSION_OBSERVATION_RE.test(text)) return false;
  if (PRESENTATION_HEADER_RE.test(text.trim())) return false;
  if (SCRATCH_WORK_RE.test(text)) return false;
  const durableArchitecture = isDurableArchitectureFact(text);
  if (TRANSIENT_DECISION_RE.test(text) && !durableArchitecture) return false;
  if (isProcessOnlyStatement(text)) return false;
  const lower = text.toLowerCase();
  return (
    durableArchitecture ||
    DECISION_SIGNALS.some((sig) => lower.includes(sig.toLowerCase())) ||
    DURABLE_DECISION_SIGNALS.some((sig) => lower.includes(sig)) ||
    IMPLEMENTATION_RE.test(text)
  );
}

function isUserErrorReport(text: string): boolean {
  if (SCRATCH_WORK_RE.test(text)) return false;
  return ERROR_LINE_RE.test(text) &&
    !/\b(need to|going to|should|will update|will add|now)\b/i.test(text);
}

// Extract the first clean sentence/paragraph containing a decision signal.
// Skips code blocks, markdown headers, and list items.
function extractDecisionSnippet(content: string): string {
  const segments = content.split(/(?<=[.!?])\s+|\n+/);
  for (const segment of segments) {
    const s = segment.trim();
    if (s.length < 10 || s.length > 200) continue;
    if (s.includes("```") || s.startsWith("#")) continue;
    const normalized = s.replace(/^\s*[-*]\s+/, "");
    const lower = normalized.toLowerCase();
    if (TRANSIENT_DECISION_RE.test(normalized)) continue;
    if (
      DECISION_SIGNALS.some(sig => lower.includes(sig.toLowerCase())) ||
      DURABLE_DECISION_SIGNALS.some(sig => lower.includes(sig))
    ) {
      return cleanSnippet(normalized, 140) ?? normalized;
    }
  }
  // fallback: first non-code, non-header line
  const firstLine = content.split("\n").find(l => {
    const t = l.trim();
    return t.length > 5 && !t.startsWith("#") && !t.startsWith("-") && !t.startsWith("*") && !t.includes("```");
  }) ?? content;
  return firstLine.length > 120 ? firstLine.slice(0, 119) + "…" : firstLine;
}

function extractDecisionCandidates(messages: WeightedMessage[], patternDecisions: string[]): string[] {
  const decisions: string[] = [];
  const seen = new Set<string>();

  function add(value: string | null): void {
    const cleaned = cleanDecisionCandidate(value ?? "");
    if (!cleaned || cleaned.length < 8 || !isDecisionLike(cleaned)) return;
    const key = cleaned.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      decisions.push(cleaned);
    }
  }

  for (const decision of patternDecisions) add(decision);

  for (const m of messages) {
    if (m.type === "decision") add(extractDecisionSnippet(m.message.content));

    if (m.message.role !== "assistant") continue;
    const segments = m.message.content.split(/(?<=[.!?])\s+|\n+/);
    for (const segment of segments) {
      const trimmed = segment.trim();
      if (trimmed.length < 10 || trimmed.length > 220) continue;
      if (trimmed.includes("```") || trimmed.startsWith("#")) continue;
      if (!isDecisionLike(trimmed)) continue;
      add(trimmed);
      if (decisions.length >= 8) return decisions;
    }
  }

  return decisions;
}

function extractErrorCandidates(messages: WeightedMessage[], events: ReturnType<typeof classifyToolEvent>[]): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();

  function add(value: string | null): void {
    const cleaned = cleanSnippet(value ?? "", 180);
    if (!cleaned || cleaned.length < 6) return;
    const key = cleaned.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      errors.push(cleaned);
    }
  }

  for (const m of messages) {
    if (m.type === "error" && m.message.role === "user" && isUserErrorReport(m.message.content)) {
      add(m.message.content);
      continue;
    }
  }

  for (const event of events) {
    if (event?.type === "error") add((event.payload as any).message as string);
    if (event?.type === "build_attempt" && (event.payload as any).success === false) {
      add((event.payload as any).errorSummary as string);
    }
  }

  return errors;
}

function extractFacts(
  weightedMessages: WeightedMessage[],
  events: ReturnType<typeof classifyToolEvent>[],
  goal: string | null,
  decisions: string[],
  errors: string[],
  keywords: string[]
): ExtractedFact[] {
  const facts: ExtractedFact[] = [];
  const seen = new Set<string>();

  if (goal) {
    addFact(facts, seen, {
      kind: "goal",
      text: goal,
      source: "user_message",
      sourceIndex: weightedMessages.find((m) => m.message.content === goal)?.message.index,
      confidence: 0.8,
      durability: "session",
    });
  }

  for (const decision of decisions) {
    addFact(facts, seen, {
      kind: "decision",
      text: decision,
      source: "assistant_message",
      confidence: isDurableArchitectureFact(decision) || IMPLEMENTATION_RE.test(decision) ? 0.8 : 0.65,
      durability: classifyDecision(decision) === "architecture" || classifyDecision(decision) === "convention" ? "project" : "session",
      category: classifyDecision(decision),
    });
  }

  for (const error of errors) {
    if (SCRATCH_WORK_RE.test(error)) continue;
    addFact(facts, seen, {
      kind: "issue",
      text: error,
      source: "user_message",
      confidence: 0.8,
      durability: "session",
      status: "open",
      evidence: error,
    });
  }

  for (const event of events) {
    if (!event) continue;
    const payload = event.payload as any;
    if (event.type === "file_created" || event.type === "file_modified") {
      addFact(facts, seen, {
        kind: "work",
        text: `Updated ${payload.path}`,
        source: "tool_event",
        confidence: 0.9,
        durability: "session",
      });
    } else if (event.type === "test_run") {
      const command = payload.command ?? "Tests";
      const result = payload.failed > 0 ? "failed" : "passed";
      addFact(facts, seen, {
        kind: "validation",
        text: `${command} ${result}`,
        source: "tool_event",
        confidence: 0.9,
        durability: "session",
      });
    } else if (event.type === "build_attempt") {
      const command = payload.command ?? "Build";
      const result = payload.success ? "passed" : "failed";
      addFact(facts, seen, {
        kind: "validation",
        text: `${command} ${result}`,
        source: "tool_event",
        confidence: 0.85,
        durability: "session",
      });
      if (!payload.success && payload.errorSummary) {
        addFact(facts, seen, {
          kind: "issue",
          text: payload.errorSummary,
          source: "tool_event",
          confidence: 0.9,
          durability: "session",
          status: "open",
          evidence: command,
        });
      }
    }
  }

  for (const keyword of keywords) {
    addFact(facts, seen, {
      kind: "keyword",
      text: keyword,
      source: "user_message",
      confidence: 0.6,
      durability: "session",
    });
  }

  return facts;
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
  const decisions = extractDecisionCandidates(
    weightedMessages,
    patterns
      .filter((p) => p.type === "confirmation" && p.extractedDecision !== null)
      .map((p) => p.extractedDecision!)
  );

  // Step 12: errors — 'error' typed messages + error events
  // Only user messages or short assistant messages (< 300 chars) — avoids dumping long Q&A responses
  const errors = extractErrorCandidates(weightedMessages, events);

  // Step 13: token count estimate
  const tokenCount = weightedMessages
    .filter((m) => m.weight > 0.5)
    .reduce((sum, m) => sum + Math.ceil(m.message.content.length / 4), 0);
  const facts = extractFacts(weightedMessages, events, goal, decisions, errors, keywords);

  return {
    session_id: messages[0]?.session_id ?? ("" as any),
    goal,
    facts,
    weightedMessages,
    events,
    decisions,
    errors,
    keywords,
    patterns,
    tokenCount,
  };
}
