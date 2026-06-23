// Layer 2 — AI summarizer (optional, best-effort).
// Calls Claude Haiku to condense raw Layer1 decisions/errors/goal into
// clean, complete sentences before they enter the digest.
// Returns the input unchanged if ANTHROPIC_API_KEY is not set or call fails.

import Anthropic from "@anthropic-ai/sdk";
import type { Layer1Output } from "../types/index.js";

let client: Anthropic | null = null;
let warnedNoKey = false;

function getClient(): Anthropic | null {
  if (!process.env["ANTHROPIC_API_KEY"]) {
    if (!warnedNoKey) {
      console.error("[ctx-memory] ANTHROPIC_API_KEY not set — using heuristic digest (no AI summarization).");
      console.error("[ctx-memory] Set ANTHROPIC_API_KEY for higher-quality session digests.");
      warnedNoKey = true;
    }
    return null;
  }
  if (!client) client = new Anthropic();
  return client;
}

// Summarize a list of raw strings into clean 1-sentence summaries.
async function summarizeList(items: string[], context: string): Promise<string[]> {
  if (items.length === 0) return [];
  const sdk = getClient();
  if (!sdk) return items;

  const prompt = `You are summarizing ${context} from a coding session.
For each item below, write ONE concise sentence (max 100 chars) that captures the core meaning.
Keep technical specifics (tech names, file names, error types). Drop filler text, markdown, lists, and code blocks.
If an item is already a clean short sentence, return it as-is.
Output ONLY a JSON array of strings, one per input item, in the same order.

Items:
${JSON.stringify(items)}`;

  try {
    const response = await sdk.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content.find(b => b.type === "text")?.text ?? "";
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return items;
    const parsed = JSON.parse(match[0]) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== items.length) return items;
    return (parsed as string[]).map(s => String(s).slice(0, 150));
  } catch {
    return items;
  }
}

// Summarize the goal into a clean 1-line description.
async function summarizeGoal(goal: string | null): Promise<string | null> {
  if (!goal || goal === "No goal detected" || goal.length <= 120) return goal;
  const sdk = getClient();
  if (!sdk) return goal;

  try {
    const response = await sdk.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 200,
      messages: [{
        role: "user",
        content: `Summarize this coding task request in ONE clear sentence (max 120 chars). Keep technical details. Output only the sentence, no quotes.\n\n${goal}`,
      }],
    });
    const text = response.content.find(b => b.type === "text")?.text?.trim() ?? "";
    return text.length > 0 ? text.slice(0, 150) : goal;
  } catch {
    return goal;
  }
}

// Main export: enrich Layer1Output with AI-summarized fields.
// Always returns a valid Layer1Output — never throws.
export async function summarizeLayer1(layer1: Layer1Output): Promise<Layer1Output> {
  try {
    const [goal, decisions, errors] = await Promise.all([
      summarizeGoal(layer1.goal),
      summarizeList(layer1.decisions, "technical decisions made by the AI assistant"),
      summarizeList(layer1.errors, "errors encountered during the session"),
    ]);

    return { ...layer1, goal, decisions, errors };
  } catch {
    return layer1;
  }
}
