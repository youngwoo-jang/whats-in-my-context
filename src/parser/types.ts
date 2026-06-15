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
  /** epoch ms of the `Agent` tool_use entry — the subagent's spawn time, for elapsed. */
  startedAt?: number;
}

/**
 * A background shell (a `Bash` tool_use with run_in_background:true), reconstructed
 * from the transcript: the launch ID + command, and a lifecycle status updated by
 * the completion notification / KillShell. Live shells render below the subagents.
 */
export interface ShellRecord {
  /** harness shell id, e.g. "b0qw539vz" (from the launch tool_result). */
  id: string;
  command: string;
  /** "running" until a task-notification (completed/failed) or a kill. */
  status: string;
  /** epoch ms of the launch tool_result entry — the shell's spawn time, for elapsed. */
  startedAt?: number;
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
  /** Background shells reconstructed from the transcript (any status). */
  shells: ShellRecord[];
  entryCount: number;
  skippedLines: number;
}
