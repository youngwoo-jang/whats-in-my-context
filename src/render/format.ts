/** Master agent view: total + four components (System/Thinking/Tools/Conversation). */
export interface MasterView {
  title: string;
  totalTokens: number;
  totalExact: boolean;
  system: number;
  thinking: number;
  conversation: number;
  tools: { total: number; Bash: number; Web: number; File: number };
}

/** Subagent view: type + description header, optional handoff (no internal breakdown). */
export interface SubagentView {
  type: string;
  description: string;
  totalTokens: number;
  /** false when the harness reported no token count (rendered as "—"). */
  totalKnown: boolean;
  /** capped (≤200 char) handoff text + the handoff's token size. */
  handoff?: { text: string; tokens: number };
}

/** Width the handoff quote is word-wrapped to (statusLine §4). */
export const WRAP_WIDTH = 80;

export const WARN_RATIO = 0.4;
export const DANGER_RATIO = 0.6;

const DIM = "\x1b[2m";
const ITALIC = "\x1b[3m";
const RESET = "\x1b[0m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[1;31m";
const ORANGE = "\x1b[38;5;208m"; // master name
const TEAL = "\x1b[38;5;37m"; // subagent names
function dim(s: string, color: boolean): string {
  return color ? `${DIM}${ITALIC}${s}${RESET}` : s;
}

/** Tokens as a compact "k" string: 142000 → "142.0k" (DESIGN.md §4). */
export function formatTokens(n: number): string {
  const v = Number.isFinite(n) ? n : 0;
  return (v / 1000).toFixed(1) + "k";
}

/** Context fill as a whole-number percent of the window, or null if unknown. */
export function loadPercent(total: number, windowSize: number): number | null {
  if (!windowSize || windowSize <= 0) return null;
  return Math.round((total / windowSize) * 100);
}

/** A 10-segment fill gauge, e.g. 57% → "[██████░░░░]" (trailing, so width-safe). */
const GAUGE_SEGMENTS = 10;
function gauge(pct: number): string {
  const filled = Math.max(0, Math.min(GAUGE_SEGMENTS, Math.round((pct / 100) * GAUGE_SEGMENTS)));
  return "[" + "█".repeat(filled) + "░".repeat(GAUGE_SEGMENTS - filled) + "]";
}

/**
 * The fill indicator after a total, colored by fill (DESIGN.md §4): ≥ 40% yellow,
 * ≥ 60% red, otherwise no color. "" when the window is unknown. With `bar`, a
 * fuel-gauge precedes the percent (`[██████░░░░] 57%`); else just `57%`.
 */
function loadTag(total: number, windowSize: number, color: boolean, bar = false): string {
  const pct = loadPercent(total, windowSize);
  if (pct === null) return "";
  const body = bar ? `${gauge(pct)} ${pct}%` : `${pct}%`;
  if (!color) return "  " + body;
  const c = pct >= DANGER_RATIO * 100 ? RED : pct >= WARN_RATIO * 100 ? YELLOW : "";
  return "  " + (c ? c + body + RESET : body);
}

const VALUE_COL = 40;

function row(label: string, value: string): string {
  // Min 3 spaces so an overflowing (long) label never crowds its value.
  const pad = Math.max(3, VALUE_COL - label.length - value.length);
  return label + " ".repeat(pad) + value;
}

// Color only the agent name. Padding is computed from the PLAIN label (row), then
// zero-width ANSI codes are wrapped around the label text so alignment is unchanged.
function header(label: string, total: string, tag: string, nameColor = ""): string {
  const line = row(label, total);
  if (!nameColor) return line + tag;
  return nameColor + label + RESET + line.slice(label.length) + tag;
}

// Markers / separators are width-1 ASCII. Two constraints drive this (DESIGN.md §4):
//  1. statusLine strips each line's LEADING whitespace, so indentation must be a
//     visible character, not spaces.
//  2. box-drawing and ▸ · are East-Asian "Ambiguous width" (1 col in Latin
//     terminals, 2 in CJK), which breaks column alignment — ASCII stays width-1.
const BULLET = "- ";

/** Render the master block: header + System/Thinking/Tools/Conversation. */
export function renderMaster(v: MasterView, windowSize: number, color = false): string[] {
  const tag = loadTag(v.totalTokens, windowSize, color, /* bar */ true);
  const total = formatTokens(v.totalTokens) + (v.totalExact ? "" : "?");
  const toolsInline =
    `Bash ${formatTokens(v.tools.Bash)} | ` +
    `Web ${formatTokens(v.tools.Web)} | ` +
    `File ${formatTokens(v.tools.File)}`;
  return [
    header(v.title, total, tag, color ? ORANGE : ""),
    row(BULLET + "System", formatTokens(v.system)),
    row(BULLET + "Thinking", formatTokens(v.thinking)),
    row(BULLET + "Tools", formatTokens(v.tools.total)) + "   " + toolsInline,
    row(BULLET + "Conversation", formatTokens(v.conversation)),
  ];
}

/** Greedy word-wrap to `width` columns (no leading-space continuations). */
function wrapWords(text: string, width: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const w of text.split(" ")) {
    if (cur && (cur + " " + w).length > width) {
      out.push(cur);
      cur = w;
    } else {
      cur = cur ? cur + " " + w : w;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Render a subagent block: header (`<type> · <description>`, only the type
 * colored), then the handoff quote word-wrapped to WRAP_WIDTH, then a
 * `- handoff <size>` row. No `>` marker (DESIGN.md §4).
 */
export function renderSubagent(v: SubagentView, windowSize: number, color = false): string[] {
  // No harness count → show "—" (not a misleading "0.0k") and no fill %.
  const tag = v.totalKnown ? loadTag(v.totalTokens, windowSize, color) : "";
  const total = v.totalKnown ? formatTokens(v.totalTokens) : "—";
  const label = v.description ? `${v.type} · ${v.description}` : v.type;
  const plain = row(label, total);
  // Color only the type (first v.type.length chars); padding from the plain label.
  const head = color ? TEAL + v.type + RESET + plain.slice(v.type.length) + tag : plain + tag;

  const lines = [head];
  const h = v.handoff;
  if (h && h.text) {
    const segs = wrapWords(h.text, WRAP_WIDTH);
    segs[0] = `"${segs[0]}`;
    segs[segs.length - 1] = `${segs[segs.length - 1]}"`;
    // Handoff size suffix at the very end of the (wrapped) quote.
    segs.forEach((s, i) => {
      const suffix = i === segs.length - 1 ? "  " + formatTokens(h.tokens) : "";
      lines.push(dim(s, color) + suffix);
    });
  }
  return lines;
}

// Block separator. statusLine drops blank/whitespace-only lines, so a real empty
// line collapses; a lone zero-width space survives trimming yet renders blank.
export const BLOCK_SEP = "\n​\n";

/** Render the full tree: master block, blank line, then each subagent block. */
export function renderTree(
  master: MasterView,
  subagents: SubagentView[],
  windowSize: number,
  color = false
): string {
  const blocks = [renderMaster(master, windowSize, color).join("\n")];
  for (const s of subagents) blocks.push(renderSubagent(s, windowSize, color).join("\n"));
  return blocks.join(BLOCK_SEP);
}
