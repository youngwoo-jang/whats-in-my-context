import { parseTranscriptCached } from "./cache";
import { computeThinking, estimateTokens } from "../parser";
import { AgentHandoff, ParseResult } from "../parser/types";
import { MasterView, SubagentView, renderTree } from "./format";
import { SubagentTask, readTasks } from "./dump";

const HANDOFF_CAP = 200;

const EMPTY: ParseResult = {
  totalTokens: 0,
  totalExact: false,
  systemTokens: 0,
  systemExact: false,
  tools: { total: 0, Bash: 0, Web: 0, File: 0 },
  conversation: 0,
  agentHandoffs: [],
  entryCount: 0,
  skippedLines: 0,
};

export interface StatusInput {
  transcriptPath?: string;
  windowSize: number;
  /** master total from statusLine `context_window.current_usage` (authoritative). */
  masterTotal?: { tokens: number; exact: boolean };
  tasks: SubagentTask[];
}

function buildMasterView(parsed: ParseResult, masterTotal?: { tokens: number; exact: boolean }): MasterView {
  const total = masterTotal ? masterTotal.tokens : parsed.totalTokens;
  const totalExact = masterTotal ? masterTotal.exact : parsed.totalExact;
  const thinking = computeThinking(total, parsed.systemTokens, parsed.tools.total, parsed.conversation);
  return {
    title: "master",
    totalTokens: total,
    totalExact,
    system: parsed.systemTokens,
    thinking,
    conversation: parsed.conversation,
    tools: parsed.tools,
  };
}

/** Collapse whitespace and cap the handoff to HANDOFF_CAP chars with an ellipsis. */
function capHandoff(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > HANDOFF_CAP ? t.slice(0, HANDOFF_CAP) + "…" : t;
}

export function buildSubagentView(t: SubagentTask, handoffByDesc: Map<string, AgentHandoff>): SubagentView {
  const description = (t.description || "").trim();
  const match = description ? handoffByDesc.get(description) : undefined;

  // Real agent type comes from the matched Agent tool_use (subagentStatusLine only
  // reports a generic "local_agent"); fall back to the task's own type.
  const type = match?.subagentType || t.type || t.label || t.name || "agent";

  // Handoff is the matched master prompt (the description is already in the header).
  const handoff = match?.prompt
    ? { text: capHandoff(match.prompt), tokens: estimateTokens(match.prompt) }
    : undefined;

  // tokenCount can arrive as 0 even while the agent is active; fall back to the
  // largest tokenSample. If everything is 0, the harness has no count for this
  // task (totalKnown=false → rendered as "—" rather than a misleading "0.0k").
  const samples = Array.isArray(t.tokenSamples)
    ? t.tokenSamples.filter((n): n is number => typeof n === "number")
    : [];
  const total = Math.max(t.tokenCount || 0, ...(samples.length ? samples : [0]));

  return {
    type,
    description,
    totalTokens: total,
    totalKnown: total > 0,
    handoff,
  };
}

/** Assemble the whole tree string from a normalized status input. */
export function buildStatusLine(input: StatusInput, color = false): string {
  const parsed = input.transcriptPath ? parseTranscriptCached(input.transcriptPath) : EMPTY;
  const master = buildMasterView(parsed, input.masterTotal);

  const handoffByDesc = new Map<string, AgentHandoff>();
  for (const h of parsed.agentHandoffs) {
    if (h.description) handoffByDesc.set(h.description, h);
  }
  const subs = input.tasks.map((t) => buildSubagentView(t, handoffByDesc));

  return renderTree(master, subs, input.windowSize, color);
}

/** Full render directly from the parsed statusLine stdin object. */
export function renderFromStatusJSON(data: any, color = true): string {
  const cw = (data && data.context_window) || {};
  const windowSize = cw.context_window_size || 200000;
  let masterTotal: { tokens: number; exact: boolean } | undefined;
  const cu = cw.current_usage;
  if (cu) {
    const tokens =
      (cu.input_tokens || 0) +
      (cu.cache_creation_input_tokens || 0) +
      (cu.cache_read_input_tokens || 0);
    // Just after a compact, current_usage can be present but all-zero (the first
    // post-compact request hasn't been issued yet). Treat zero as "no reading" and
    // fall back to the transcript's last usage rather than rendering total = 0.
    if (tokens > 0) masterTotal = { tokens, exact: true };
  }
  const sessionId = (data && data.session_id) || "default";
  return buildStatusLine(
    {
      transcriptPath: data && data.transcript_path,
      windowSize,
      masterTotal,
      tasks: readTasks(sessionId),
    },
    color
  );
}
