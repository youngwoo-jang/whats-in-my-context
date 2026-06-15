import { parseTranscriptCached, parseSubagentShellsCached } from "./cache";
import { computeThinking, estimateTokens } from "../parser";
import { AgentHandoff, ParseResult, ShellRecord } from "../parser/types";
import { MasterView, ShellView, SubagentView, renderTree } from "./format";
import { SubagentTask, readTasks } from "./dump";
import { Liveness, probeShellLiveness } from "./liveness";
import { SubagentLive, readSubagentLive, resolveDotPhases, subagentTranscriptPath } from "./subagent";

/** Batched liveness probe (path[] → verdict map); injectable so tests don't shell out. */
export type ShellLivenessProbe = (outputPaths: string[]) => Map<string, Liveness>;

const HANDOFF_CAP = 200;

const EMPTY: ParseResult = {
  totalTokens: 0,
  totalExact: false,
  systemTokens: 0,
  systemExact: false,
  tools: { total: 0, Bash: 0, Web: 0, File: 0 },
  conversation: 0,
  agentHandoffs: [],
  shells: [],
  entryCount: 0,
  skippedLines: 0,
};

/** Per-subagent live-signal lookup (taskId → its transcript-derived signals). */
export type SubagentLiveLookup = (taskId: string) => SubagentLive;
/** Dot-phase resolver (mtimes by taskId → phase 0..2 by taskId). */
export type DotPhaseResolver = (mtimes: Map<string, number>) => Map<string, number>;
/** Per-subagent background-shell lookup (taskId → its live shell rows); injectable for tests. */
export type SubagentShellsLookup = (taskId: string) => ShellView[];

export interface StatusInput {
  transcriptPath?: string;
  /** session id, for the dot-phase pulse cache; falls back to the transcript name. */
  sessionId?: string;
  windowSize: number;
  /** master total from statusLine `context_window.current_usage` (authoritative). */
  masterTotal?: { tokens: number; exact: boolean };
  tasks: SubagentTask[];
  /** "now" for elapsed timers; defaults to Date.now() (injectable for tests). */
  now?: number;
  /** shell liveness probe; defaults to the real `lsof`-based one (injectable for tests). */
  isAlive?: ShellLivenessProbe;
  /** per-subagent live signals; defaults to reading the subagent transcript (injectable). */
  subagentLive?: SubagentLiveLookup;
  /** dot-phase resolver; defaults to the tmp-backed pulse (injectable for tests). */
  dotPhases?: DotPhaseResolver;
  /** per-subagent background shells; defaults to parsing the subagent transcript (injectable). */
  subagentShells?: SubagentShellsLookup;
}

/** ms elapsed since `startedAt`, or undefined if the spawn time is unknown/in the future. */
function ageOf(startedAt: number | undefined, now: number): number | undefined {
  if (typeof startedAt !== "number" || !Number.isFinite(startedAt)) return undefined;
  const age = now - startedAt;
  return age >= 0 ? age : undefined;
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

export function buildSubagentView(
  t: SubagentTask,
  handoffByDesc: Map<string, AgentHandoff>,
  now: number = Date.now(),
  live: SubagentLive = {},
  dotPhase?: number
): SubagentView {
  const description = (t.description || "").trim();
  const match = description ? handoffByDesc.get(description) : undefined;

  // Real agent type: the subagent's own meta.json is authoritative (the matched master
  // Agent tool_use is next; subagentStatusLine only reports a generic "local_agent").
  const type = live.agentType || match?.subagentType || t.type || t.label || t.name || "agent";

  // Handoff is the matched master prompt (the description is already in the header).
  const handoff = match?.prompt
    ? { text: capHandoff(match.prompt), tokens: estimateTokens(match.prompt) }
    : undefined;

  // Token total: the subagent's own last `usage` is the real number — the harness reports
  // tokenCount: 0 for the whole run. Fall back to tokenCount / the largest tokenSample.
  // If everything is 0, there's no count (totalKnown=false → "—", not a misleading "0.0k").
  const samples = Array.isArray(t.tokenSamples)
    ? t.tokenSamples.filter((n): n is number => typeof n === "number")
    : [];
  const total = Math.max(live.tokens || 0, t.tokenCount || 0, ...(samples.length ? samples : [0]));

  // Spawn time: the matched master `Agent` tool_use timestamp (reliable, from the
  // transcript), falling back to the harness task's own startTime if present.
  const ageMs = ageOf(match?.startedAt ?? t.startTime, now);

  // Liveness: idle = time since the subagent's transcript was last written.
  const idleMs = ageOf(live.mtimeMs, now);

  return {
    type,
    description,
    totalTokens: total,
    totalKnown: total > 0,
    handoff,
    ageMs,
    lastActivity: live.lastActivity,
    idleMs,
    dotPhase,
  };
}

/**
 * A `running` shell is "stale" — no longer assumed live — when it was launched
 * before the most recent `compact_boundary`. A /compact rewrites the context window
 * (a session-level boundary), and a shell killed out-of-band (`pkill`, process death)
 * or lost to a mid-shell session quit never produces a `task-notification` /
 * `TaskStop`, so it would otherwise be pinned to `running` forever. Treating the
 * compact boundary as terminal mirrors the staleness guard the subagent path
 * (`readTasks`) already has. A shell launched *after* the last compact is still live
 * data; one with no `startedAt` is kept (can't position it relative to the boundary).
 */
function isStaleShell(s: ShellRecord, lastCompactAt?: number): boolean {
  if (typeof lastCompactAt !== "number") return false;
  if (typeof s.startedAt !== "number") return false;
  return s.startedAt < lastCompactAt;
}

/**
 * Live running shells → views with elapsed timers (finished/killed/dead shells dropped).
 *
 * A shell killed from the Claude Code UI (the X button) leaves NO transcript signal — no
 * `TaskStop`/`KillShell` and no `task-notification <status>` — so it would otherwise stay
 * pinned `running` forever and over-count. We resolve this at the OS level: a live shell
 * keeps its `tasks/<id>.output` file open, so `probeShellLiveness` (a single batched `lsof`,
 * write-holders only) is ground truth and, unlike an mtime cutoff, stays correct for a
 * quiet-but-live process. Liveness wins when it can decide; when it can't (`lsof` missing /
 * timed out, or no captured path) we fall back to the `compact_boundary` staleness guard so
 * behavior never regresses. See BUGREPORT-auto-background-shells.md.
 */
export function buildShellViews(
  shells: ShellRecord[],
  now: number = Date.now(),
  lastCompactAt?: number,
  liveness: ShellLivenessProbe = probeShellLiveness
): ShellView[] {
  const running = shells.filter((s) => s.status === "running");
  // One batched probe for all running shells with a known output path.
  const paths = running.map((s) => s.outputPath).filter((p): p is string => !!p);
  const verdict = paths.length ? liveness(paths) : new Map<string, Liveness>();
  return running
    .filter((s) => {
      const alive = s.outputPath ? verdict.get(s.outputPath) : undefined;
      if (alive === true) return true; // a process holds the output open for write → live
      if (alive === false) return false; // lsof saw no writer → dead (UI-kill / crash / done)
      return !isStaleShell(s, lastCompactAt); // undecidable → fall back to the compact guard
    })
    .map((s) => ({ id: s.id, status: s.status, command: s.command, ageMs: ageOf(s.startedAt, now) }));
}

/** Assemble the whole tree string from a normalized status input. */
export function buildStatusLine(input: StatusInput, color = false): string {
  const parsed = input.transcriptPath ? parseTranscriptCached(input.transcriptPath) : EMPTY;
  const master = buildMasterView(parsed, input.masterTotal);
  const now = input.now ?? Date.now();

  const handoffByDesc = new Map<string, AgentHandoff>();
  for (const h of parsed.agentHandoffs) {
    if (h.description) handoffByDesc.set(h.description, h);
  }

  // Live signals from each subagent's own transcript (real tokens / type / last activity /
  // mtime) — the stdin task carries none of these while running.
  const liveLookup: SubagentLiveLookup =
    input.subagentLive ??
    ((id) => (input.transcriptPath ? readSubagentLive(input.transcriptPath, id) : {}));
  const liveByTask = new Map<string, SubagentLive>();
  for (const t of input.tasks) if (t.id) liveByTask.set(t.id, liveLookup(t.id));

  // Advance the "Running..." dots by one step for each subagent whose transcript grew.
  const mtimes = new Map<string, number>();
  for (const t of input.tasks) {
    const m = t.id ? liveByTask.get(t.id)?.mtimeMs : undefined;
    if (t.id && typeof m === "number") mtimes.set(t.id, m);
  }
  const sessionId = input.sessionId || "default";
  const phaseResolver: DotPhaseResolver = input.dotPhases ?? ((mt) => resolveDotPhases(sessionId, mt, now));
  const phases = phaseResolver(mtimes);

  // Each subagent's own background shells: parsed from ITS transcript (the master records
  // none of them), then run through the same liveness probe as the master's shells.
  const shellsLookup: SubagentShellsLookup =
    input.subagentShells ??
    ((id) => {
      if (!input.transcriptPath) return [];
      try {
        const sub = parseSubagentShellsCached(subagentTranscriptPath(input.transcriptPath, id));
        return buildShellViews(sub.shells, now, sub.lastCompactAt, input.isAlive);
      } catch {
        return [];
      }
    });

  const subs = input.tasks.map((t) => {
    const view = buildSubagentView(t, handoffByDesc, now, t.id ? liveByTask.get(t.id) : undefined, t.id ? phases.get(t.id) : undefined);
    view.shells = t.id ? shellsLookup(t.id) : [];
    return view;
  });
  const shells = buildShellViews(parsed.shells, now, parsed.lastCompactAt, input.isAlive);

  return renderTree(master, subs, shells, input.windowSize, color);
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
      sessionId,
      windowSize,
      masterTotal,
      tasks: readTasks(sessionId),
    },
    color
  );
}
