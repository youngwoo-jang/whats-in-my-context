function usageTotal(u: any): number {
  return (
    (u.cache_read_input_tokens || 0) +
    (u.cache_creation_input_tokens || 0) +
    (u.input_tokens || 0)
  );
}

/**
 * The first and last assistant-usage totals (DESIGN.md §2):
 *  - first turn  → System (the fixed harness baseline)
 *  - last turn   → current total context
 * `output_tokens` is excluded. Missing usage → 0 / not exact.
 */
export function computeUsageBounds(entries: any[]): {
  totalTokens: number;
  totalExact: boolean;
  systemTokens: number;
  systemExact: boolean;
} {
  let first: any = null;
  let last: any = null;
  for (const e of entries) {
    if (e?.type === "assistant" && e?.message?.usage) {
      if (!first) first = e.message.usage;
      last = e.message.usage;
    }
  }
  return {
    totalTokens: last ? usageTotal(last) : 0,
    totalExact: !!last,
    systemTokens: first ? usageTotal(first) : 0,
    systemExact: !!first,
  };
}
