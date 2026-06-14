/**
 * Zero-dependency token estimate: ~4 chars per token (DESIGN.md §5 — "char/4 ok").
 * Good enough for relative noise slices; we never need exact per-block tokens.
 */
export function estimateTokens(s: string | null | undefined): number {
  if (!s) return 0;
  return Math.ceil(s.length / 4);
}
