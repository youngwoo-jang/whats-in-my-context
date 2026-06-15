import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * Live signals for a running subagent, recovered from its own transcript that the
 * harness writes beside the master at `<master-dir>/<session>/subagents/agent-<id>.jsonl`
 * (+ a `.meta.json` sidecar). The `subagentStatusLine` stdin reports `tokenCount: 0` and a
 * generic `local_agent` type for the WHOLE run, so these are the only way to show a real
 * token count, the real agent type, and — crucially — whether the agent is still moving.
 */
export interface SubagentLive {
  /** real total tokens from the subagent's last assistant `usage` (stdin reports 0). */
  tokens?: number;
  /** real agent type from `agent-<id>.meta.json` (stdin reports a generic "local_agent"). */
  agentType?: string;
  /** the subagent's last meaningful activity (assistant text / tool_use / thinking). */
  lastActivity?: string;
  /** mtime of the subagent transcript — its last sign of life (drives idle + the pulse). */
  mtimeMs?: number;
}

/** Only the tail is read: the last `usage` and last activity are always near the end. */
const TAIL_BYTES = 64 * 1024;

/** The subagents dir that sits beside the master transcript (`<dir>/<name>/subagents`). */
function subagentDir(masterTranscriptPath: string): string {
  const dir = path.dirname(masterTranscriptPath);
  const name = path.basename(masterTranscriptPath).replace(/\.jsonl$/, "");
  return path.join(dir, name, "subagents");
}

/**
 * Absolute path of a subagent's own transcript (`…/subagents/agent-<id>.jsonl`),
 * derived from the master transcript + task id. Background shells a subagent launches
 * are recorded in THIS file, not the master — so the master statusLine parses it to
 * attribute those shells to the subagent that owns them (build.ts).
 */
export function subagentTranscriptPath(masterTranscriptPath: string, taskId: string): string {
  return path.join(subagentDir(masterTranscriptPath), `agent-${taskId}.jsonl`);
}

/** Read the last `bytes` of a file plus its mtime, or null if unreadable. */
function readTail(file: string, bytes: number): { text: string; mtimeMs: number; truncated: boolean } | null {
  let fd: number | undefined;
  try {
    const st = fs.statSync(file);
    fd = fs.openSync(file, "r");
    const start = Math.max(0, st.size - bytes);
    const len = st.size - start;
    const buf = Buffer.allocUnsafe(len);
    const read = fs.readSync(fd, buf, 0, len, start);
    return { text: buf.toString("utf8", 0, read), mtimeMs: st.mtimeMs, truncated: start > 0 };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }
}

/** Compact a tool_use into "<name> <primary arg>" for the activity line. */
function formatTool(name: string, input: any): string {
  const arg =
    input?.command ??
    input?.file_path ??
    input?.path ??
    input?.pattern ??
    input?.query ??
    input?.url ??
    input?.description;
  return arg ? `${name} ${String(arg)}` : name;
}

/** Last meaningful content block across an assistant turn → a one-line activity string. */
function activityOf(content: any[], prev?: string): string | undefined {
  let act = prev;
  for (const b of content) {
    if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) act = b.text.trim();
    else if (b?.type === "tool_use" && b?.name) act = formatTool(b.name, b.input);
    else if (b?.type === "thinking") act = "(thinking)";
  }
  return act;
}

/** Sum of an assistant `usage` (input + cache creation + cache read), like the master. */
function usageTotal(u: any): number {
  return (
    (u?.input_tokens || 0) +
    (u?.cache_creation_input_tokens || 0) +
    (u?.cache_read_input_tokens || 0)
  );
}

/**
 * Read the per-subagent transcript for live signals. Never throws (status-line tick); a
 * missing/unreadable file yields an empty result so the caller falls back to stdin data.
 */
export function readSubagentLive(masterTranscriptPath: string, taskId: string): SubagentLive {
  if (!masterTranscriptPath || !taskId) return {};
  const base = path.join(subagentDir(masterTranscriptPath), `agent-${taskId}`);

  const live: SubagentLive = {};

  // meta.json (small) → real agent type.
  try {
    const meta = JSON.parse(fs.readFileSync(base + ".meta.json", "utf8"));
    if (meta && typeof meta.agentType === "string") live.agentType = meta.agentType;
  } catch {
    /* no meta — agentType falls back to the handoff/stdin value */
  }

  // jsonl tail → real token total + last activity + mtime.
  const tail = readTail(base + ".jsonl", TAIL_BYTES);
  if (!tail) return live;
  live.mtimeMs = tail.mtimeMs;

  // Only when the read started mid-file is the first line partial — drop it then. If the
  // whole file fit, keep every line (else a single-entry transcript would vanish).
  let body = tail.text;
  if (tail.truncated) {
    const nl = body.indexOf("\n");
    if (nl >= 0) body = body.slice(nl + 1);
  }
  let tokens: number | undefined;
  let activity: string | undefined;
  for (const line of body.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let e: any;
    try {
      e = JSON.parse(t);
    } catch {
      continue;
    }
    if (e?.type === "assistant" && e?.message) {
      if (e.message.usage) tokens = usageTotal(e.message.usage);
      if (Array.isArray(e.message.content)) activity = activityOf(e.message.content, activity);
    }
  }
  if (typeof tokens === "number") live.tokens = tokens;
  if (activity) live.lastActivity = activity;
  return live;
}

// ── Pulse: mtime-keyed dot phase ────────────────────────────────────────────────
// A status-line script is invoked once per render and exits, so it cannot animate
// between renders. Instead the trailing "Running..." dots advance ONE step each render
// in which a subagent's transcript mtime grew, and freeze when it doesn't — making the
// dots a true liveness cue (they move iff the agent moved) rather than a fake spinner.

const PULSE_TTL_MS = 60_000; // forget tasks not seen within a minute

function pulseFile(sessionId: string): string {
  const safe = (sessionId || "default").replace(/[^a-zA-Z0-9_-]/g, "") || "default";
  return path.join(os.tmpdir(), `wimc-pulse-${safe}.json`);
}

interface PulseEntry {
  m: number;
  p: number;
  t: number;
}

function readPulse(sessionId: string): Record<string, PulseEntry> {
  try {
    const d = JSON.parse(fs.readFileSync(pulseFile(sessionId), "utf8"));
    return d && typeof d.v === "object" && d.v ? d.v : {};
  } catch {
    return {};
  }
}

function writePulse(sessionId: string, v: Record<string, PulseEntry>): void {
  try {
    fs.writeFileSync(pulseFile(sessionId), JSON.stringify({ v }));
  } catch {
    /* tmp not writable — pulse just won't persist; dots stay at phase 0 */
  }
}

/**
 * Advance each task's dot phase (0..2 → 1..3 dots): +1 when its mtime grew since the last
 * render, unchanged otherwise. Persists per-session state to tmp. Returns taskId → phase.
 * A no-op (and no write) when there are no live mtimes, to avoid churn on idle ticks.
 */
export function resolveDotPhases(
  sessionId: string,
  mtimes: Map<string, number>,
  now: number = Date.now()
): Map<string, number> {
  const out = new Map<string, number>();
  if (mtimes.size === 0) return out;

  const prev = readPulse(sessionId);
  const next: Record<string, PulseEntry> = {};
  // Carry forward recently-seen entries so a task that briefly drops out of one render
  // doesn't reset its phase.
  for (const [id, e] of Object.entries(prev)) {
    if (e && typeof e.t === "number" && now - e.t <= PULSE_TTL_MS) next[id] = e;
  }
  for (const [id, m] of mtimes) {
    const before = prev[id];
    let p = before ? before.p : 0;
    if (before && m > before.m) p = (p + 1) % 3;
    next[id] = { m, p, t: now };
    out.set(id, p);
  }
  writePulse(sessionId, next);
  return out;
}
