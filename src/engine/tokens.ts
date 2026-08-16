// Deterministic token estimate for the token-range validator (MVP: heuristic, not a model
// tokenizer). Approximates ~4 chars/token with a word-count floor, which is stable and good
// enough to catch grossly under/over-sized context packages. The actual bounds live in
// workflow.yaml's token-range validator — do not duplicate them here.
export function estimateTokens(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return 0;
  }
  const byChars = Math.ceil(trimmed.length / 4);
  const byWords = trimmed.split(/\s+/).length;
  return Math.max(byChars, byWords);
}
