// Pure positional weight — no content, no side effects.

import type { MessageRole } from "../types/index.js";

/**
 * Returns a positional weight 0–1 based on where a message sits in the
 * conversation. Rule 4 (assistant long response) is handled by the weight
 * combiner which has access to content length.
 *
 * Priority order:
 *   index === 0                      → 1.0
 *   index >= totalMessages - 3       → 0.8
 *   index / totalMessages < 0.1      → 0.7
 *   everything else                  → 0.4
 */
export function analyzePosition(
  index: number,
  totalMessages: number,
  _role: MessageRole
): number {
  // _role is intentionally unused — position scoring depends only on index
  if (index === 0) return 1.0;
  if (totalMessages > 0 && index >= totalMessages - 3) return 0.8;
  if (totalMessages > 0 && index / totalMessages < 0.1) return 0.7;
  return 0.4;
}
