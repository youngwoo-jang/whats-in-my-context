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
  /**
   * Absolute path of the harness `tasks/<id>.output` file from the launch echo. A live
   * shell keeps this file open (stdout/stderr redirect), so whether a process still holds
   * it open is a ground-truth liveness check — see `shellAliveByOutput`. This catches
   * UI-kills, which leave no transcript signal.
   */
  outputPath?: string;
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
  /**
   * Epoch ms of the most recent `compact_boundary`, or undefined if the session
   * was never compacted. A /compact rewrites the context window (a session-level
   * boundary), so a shell launched before it with no terminal event can no longer
   * be assumed live — see `buildShellViews`.
   */
  lastCompactAt?: number;
  entryCount: number;
  skippedLines: number;
}
