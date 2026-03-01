// Message types — raw storage, Layer 1 scoring output, and structural signals.

import type { UUID, UnixMs } from "./core.js";

export type MessageRole = "user" | "assistant";

// ─── Raw message (opt-in storage) ────────────────────────────────────────────

export interface Message {
  id: UUID;
  session_id: UUID;
  role: MessageRole;
  content: string;
  index: number;       // position in conversation
  timestamp: UnixMs;
}

// ─── Layer 1 output ───────────────────────────────────────────────────────────

/** Signals extracted from a single message's text. */
export interface StructuralFeatures {
  length: number;
  hasCodeBlock: boolean;
  hasFilePath: boolean;
  hasUrl: boolean;
  hasError: boolean;
  hasDecisionPhrase: boolean;  // "I decided", "let's go with", etc.
  hasGoalPhrase: boolean;      // "the goal is", "I need to", etc.
  questionCount: number;
  imperativeCount: number;     // sentences starting with a verb
  sentenceCount: number;
  startsWithVerb: boolean;
  isShortConfirmation: boolean;
  positionalWeight: number;    // 0–1 based on position in conversation
}

/** A message annotated with its computed importance score. */
export interface WeightedMessage {
  message: Message;
  tfidfScore: number;
  signalBoost: number;        // additive bonus from StructuralFeatures
  compositeScore: number;     // final 0–1 importance
  features: StructuralFeatures;
}

/** A pattern spanning multiple messages — detected at conversation level. */
export interface ConversationPattern {
  type: "repeated_error" | "goal_shift" | "back_and_forth" | "long_silence";
  messageIds: UUID[];
  description: string;
}
