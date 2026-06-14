import { readJsonl } from "./jsonl";
import { computeUsageBounds } from "./total";
import { estimateTokens } from "./tokens";
import { laneForTool } from "./buckets";
import { AgentHandoff, ParseResult, ToolsBreakdown } from "./types";

export { estimateTokens } from "./tokens";
export { laneForTool } from "./buckets";
export * from "./types";

/** Flatten a tool_result `content` field (string | block[]) into plain text. */
function resultTextOf(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    let s = "";
    for (const b of content) {
      if (typeof b === "string") s += b;
      else if (b && typeof b.text === "string") s += b.text;
    }
    return s;
  }
  return "";
}

/**
 * Parse a master transcript into its measurable components (DESIGN.md §2):
 *  - System: first assistant usage total (exact)
 *  - total:  last assistant usage total (exact)
 *  - Tools (Bash/Web/File + misc) and Conversation: char-estimated
 *  - Thinking is NOT computed here (it is the caller's residual)
 * Also collects `Agent` handoffs for subagent-row matching.
 */
export function parseTranscript(filePath: string): ParseResult {
  const { entries: rawEntries, skippedLines } = readJsonl(filePath);
  // Exclude subagent (sidechain) turns. Current Claude Code writes them to a
  // separate file, but older/other versions inline them with isSidechain:true;
  // counting those would corrupt the master's System/total and components.
  const entries = rawEntries.filter((e) => !(e && e.isSidechain === true));

  // A /compact rewrites the context window but leaves the pre-compact entries on
  // disk. Estimate Tools/Conversation only over the active segment — entries at or
  // after the last compact_boundary — so we don't overcount discarded history (which
  // would push the component sum past the total and clamp Thinking to 0). System and
  // total are still read over the whole file (DESIGN.md §2).
  let boundary = -1;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e?.type === "system" && e?.subtype === "compact_boundary") boundary = i;
  }
  const active = boundary >= 0 ? entries.slice(boundary) : entries;

  const tools: ToolsBreakdown = { total: 0, Bash: 0, Web: 0, File: 0 };
  let conversation = 0;
  const agentHandoffs: AgentHandoff[] = [];

  // tool attribution: block id and assistant uuid → tool name (active segment only).
  const blockIdToTool = new Map<string, string>();
  const uuidToTool = new Map<string, string>();
  for (const e of active) {
    if (e?.type === "assistant" && Array.isArray(e?.message?.content)) {
      for (const b of e.message.content) {
        if (b?.type === "tool_use" && b?.name) {
          if (b.id) blockIdToTool.set(b.id, b.name);
          if (e.uuid && !uuidToTool.has(e.uuid)) uuidToTool.set(e.uuid, b.name);
        }
      }
    }
  }

  const addToolTokens = (toolName: string, tokens: number) => {
    const lane = laneForTool(toolName);
    if (lane === "Conversation") {
      conversation += tokens;
    } else {
      tools.total += tokens;
      if (lane !== "ToolsMisc") tools[lane] += tokens;
    }
  };

  for (const e of active) {
    const content = e?.message?.content;

    if (e?.type === "assistant" && Array.isArray(content)) {
      for (const b of content) {
        if (b?.type === "text") {
          conversation += estimateTokens(b.text || "");
        } else if (b?.type === "tool_use" && b?.name) {
          addToolTokens(b.name, estimateTokens(JSON.stringify(b.input ?? {})));
          if (b.name === "Agent" && b.input) {
            agentHandoffs.push({
              description: String(b.input.description ?? ""),
              prompt: String(b.input.prompt ?? ""),
              subagentType: String(b.input.subagent_type ?? ""),
            });
          }
        }
        // `thinking` blocks are not measured here — Thinking is the residual.
      }
    } else if (e?.type === "user") {
      if (typeof content === "string") {
        conversation += estimateTokens(content);
      } else if (Array.isArray(content)) {
        for (const b of content) {
          if (b?.type !== "tool_result") continue;
          const toolName =
            (b.tool_use_id && blockIdToTool.get(b.tool_use_id)) ||
            (e.sourceToolAssistantUUID && uuidToTool.get(e.sourceToolAssistantUUID)) ||
            "";
          addToolTokens(toolName, estimateTokens(resultTextOf(b.content)));
        }
      }
    } else if (e?.type === "attachment") {
      conversation += estimateTokens(JSON.stringify(e.attachment ?? ""));
    }
  }

  const bounds = computeUsageBounds(entries);

  // Compact limbo: a compact_boundary with no assistant usage after it means the first
  // post-compact request hasn't run yet, so `bounds` still holds the STALE pre-compact
  // total. Showing it would render the old (large) number until the next turn. Instead
  // estimate the post-compact total from the active segment (System baseline + active
  // components) and mark it non-exact so it renders with a trailing "?" (DESIGN.md §2).
  let totalTokens = bounds.totalTokens;
  let totalExact = bounds.totalExact;
  const hasPostBoundaryUsage =
    boundary >= 0 && active.some((e) => e?.type === "assistant" && e?.message?.usage);
  if (boundary >= 0 && !hasPostBoundaryUsage) {
    totalTokens = bounds.systemTokens + tools.total + conversation;
    totalExact = false;
  }

  return {
    totalTokens,
    totalExact,
    systemTokens: bounds.systemTokens,
    systemExact: bounds.systemExact,
    tools,
    conversation,
    agentHandoffs,
    entryCount: rawEntries.length,
    skippedLines,
  };
}

/** Thinking = residual of the total after the measured components (DESIGN.md §2). */
export function computeThinking(
  total: number,
  system: number,
  toolsTotal: number,
  conversation: number
): number {
  return Math.max(0, total - system - toolsTotal - conversation);
}
