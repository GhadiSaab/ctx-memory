// TF-IDF keyword extractor — pure function, no I/O, never throws.

import type { WeightedMessage } from "../types/index.js";

// ─── Stopwords ────────────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  // Common English
  "the", "and", "for", "this", "that", "with", "from", "have", "will",
  "are", "was", "were", "been", "has", "had", "not", "but", "what",
  "all", "can", "its", "your", "our", "their", "they", "you", "we",
  "he", "she", "it", "be", "do", "did", "does", "is", "in", "on",
  "at", "to", "of", "a", "an", "by", "as", "or", "if", "so",
  "up", "out", "now", "then", "when", "how", "who", "which", "there",
  "here", "about", "into", "over", "after", "before", "just", "also",
  "more", "some", "any", "no", "yes", "get", "got", "let", "go",
  "see", "one", "two", "use", "used", "need", "needs", "needed",
  "now", "next", "update", "add", "fix", "cover",
  // Common code words
  "function", "const", "return", "class", "import", "export", "default",
  "type", "interface", "new", "var", "let", "null", "undefined", "true",
  "false", "void", "async", "await", "try", "catch", "throw", "else",
  "case", "break", "continue", "switch", "while", "typeof", "instanceof",
]);

const NOISE_LINE_RE = /\b(now i need|now let me|let me|also add a test|base directory for this skill|i'?ll update|i need to update)\b/i;

// ─── Preprocessing ────────────────────────────────────────────────────────────

function tokenize(content: string): string[] {
  return content
    .toLowerCase()
    // Remove code blocks
    .replace(/```[\s\S]*?```/g, " ")
    // Remove URLs
    .replace(/https?:\/\/\S+/g, " ")
    // Strip punctuation (keep only letters, digits, hyphens between words)
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

// ─── Main export ──────────────────────────────────────────────────────────────

export function extractKeywords(
  messages: WeightedMessage[],
  topN = 15
): string[] {
  const docs = messages
    .filter((m, index) => m.weight > 0.25 || m.type !== "noise" || index === 0)
    .filter((m) => !NOISE_LINE_RE.test(m.message.content))
    .map((m) => tokenize(m.message.content));

  const totalDocs = docs.length;
  if (totalDocs === 0) return [];

  // IDF: count how many documents contain each term
  const docFreq = new Map<string, number>();
  for (const tokens of docs) {
    for (const term of new Set(tokens)) {
      docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
    }
  }

  // TF-IDF: sum scores across all documents
  const scores = new Map<string, number>();
  for (const tokens of docs) {
    if (tokens.length === 0) continue;
    const termCount = new Map<string, number>();
    for (const t of tokens) termCount.set(t, (termCount.get(t) ?? 0) + 1);

    for (const [term, count] of termCount) {
      const tf = count / tokens.length;
      const df = docFreq.get(term) ?? 0;
      const idf = df === totalDocs ? 0.1 : Math.log((totalDocs + 1) / (df + 1)) + 1;
      scores.set(term, (scores.get(term) ?? 0) + tf * idf);
    }
  }

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([term]) => term);
}
