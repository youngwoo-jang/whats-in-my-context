/** Bash/Web/File sub-breakdown of the Tools component, plus its total. */
export interface ToolsBreakdown {
  total: number;
  Bash: number;
  Web: number;
  File: number;
}

/** A handoff the master sent to a subagent (from an `Agent` tool_use). */
export interface AgentHandoff {
  description: string;
  prompt: string;
  /** the real agent type (subagentStatusLine reports a generic "local_agent"). */
  subagentType: string;
}

/**
 * Parsed master transcript. `systemTokens` and `totalTokens` are exact (from the
 * first / last assistant `usage`); `tools` and `conversation` are char-estimated.
 * Thinking is NOT here — it is the residual `total − system − tools.total −
 * conversation`, computed where the authoritative total is known (DESIGN.md §2).
 */
export interface ParseResult {
  totalTokens: number;
  totalExact: boolean;
  systemTokens: number;
  systemExact: boolean;
  tools: ToolsBreakdown;
  conversation: number;
  /** Agent handoffs seen in the transcript, for subagent-row matching. */
  agentHandoffs: AgentHandoff[];
  entryCount: number;
  skippedLines: number;
}
