/** Where a tool's args/results tokens go (DESIGN.md §2). */
export type ToolLane = "Bash" | "Web" | "File" | "ToolsMisc" | "Conversation";

const WEB_TOOLS = new Set(["WebFetch", "WebSearch"]);
const FILE_TOOLS = new Set([
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "Grep",
  "Glob",
]);
const CONVERSATION_TOOLS = new Set(["Agent", "AskUserQuestion"]);

/**
 * Deterministic tool-name → lane lookup.
 *  - Bash / WebFetch+WebSearch / file ops → their Tools sub-lane
 *  - Agent / AskUserQuestion             → Conversation
 *  - everything else (mcp__*, Skill, …)  → ToolsMisc (Tools total only)
 */
export function laneForTool(name: string | null | undefined): ToolLane {
  if (!name) return "ToolsMisc";
  if (name === "Bash") return "Bash";
  if (WEB_TOOLS.has(name)) return "Web";
  if (FILE_TOOLS.has(name)) return "File";
  if (CONVERSATION_TOOLS.has(name)) return "Conversation";
  return "ToolsMisc";
}
