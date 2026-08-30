// Rough estimate: 4 characters ≈ 1 token. Good enough for relative/tuning
// comparisons (context-window trimming, the observability fallback, and the
// Thread Report's context-size metrics) — not for billing-accurate counts.
//
// TODO(tokenizer): if per-model accuracy is ever needed, swap this
// implementation for a real tokenizer (e.g. tiktoken) behind this same
// signature — every call site takes a string in, a number out, so no caller
// needs to change.
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
