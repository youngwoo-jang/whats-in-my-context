import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as path from "path";
import { formatTokens, formatDuration, loadPercent, renderMaster, renderSubagent, renderShells, MasterView, BLOCK_SEP } from "../src/render/format";
import { buildSubagentView, buildShellViews, buildStatusLine } from "../src/render/build";
import { estimateTokens } from "../src/parser";
import { ShellRecord } from "../src/parser/types";

const FIX = path.join(__dirname, "..", "..", "test", "fixtures");
const sample = path.join(FIX, "sample-session.jsonl");

const HANDOFF = "Search the auth module and list every file touching sessions.";

/** Liveness probe stub: every path undecidable (as if lsof were unavailable). */
const allUnknown = (paths: string[]) =>
  new Map<string, boolean | undefined>(paths.map((p) => [p, undefined]));

test("formatTokens: compact k, one decimal", () => {
  assert.equal(formatTokens(142000), "142.0k");
  assert.equal(formatTokens(500), "0.5k");
  assert.equal(formatTokens(undefined as any), "0.0k"); // defensive
});

test("formatDuration: h/m/s, higher units drop off, clamps negatives", () => {
  assert.equal(formatDuration(50 * 1000), "50s");
  assert.equal(formatDuration((3 * 60 + 50) * 1000), "3m 50s");
  assert.equal(formatDuration((3600 + 3 * 60 + 50) * 1000), "1h 3m 50s");
  assert.equal(formatDuration(-5000), "0s");
  assert.equal(formatDuration(NaN), "0s");
});

test("buildShellViews: only running shells, with live elapsed", () => {
  const now = 1000_000;
  const shells: ShellRecord[] = [
    { id: "b0qw539vz", command: "npm run dev", status: "running", startedAt: now - 230_000 },
    { id: "bdonewz9q", command: "sleep 2", status: "completed", startedAt: now - 5000 },
    { id: "beelv3a64", command: "x", status: "killed", startedAt: now - 9000 },
  ];
  const views = buildShellViews(shells, now);
  assert.equal(views.length, 1, "completed/killed dropped");
  assert.equal(views[0].id, "b0qw539vz");
  assert.equal(views[0].ageMs, 230_000); // → "3m 50s"
});

test("buildShellViews: drops running shells launched before the last compact_boundary", () => {
  const now = 1000_000;
  const compactAt = now - 100_000;
  const shells: ShellRecord[] = [
    // launched before the compact, no terminal event → stale, dropped
    { id: "b71gyizwc", command: "npx vitest --watch", status: "running", startedAt: compactAt - 50_000 },
    { id: "be7ken7ie", command: "until-loop", status: "running", startedAt: compactAt - 49_000 },
    // launched after the compact → still live
    { id: "bfreshpost", command: "npm run dev", status: "running", startedAt: compactAt + 10_000 },
    // no startedAt → can't position vs boundary, kept
    { id: "bnoStart", command: "tail -f log", status: "running" },
  ];
  const views = buildShellViews(shells, now, compactAt);
  assert.deepEqual(
    views.map((v) => v.id).sort(),
    ["bfreshpost", "bnoStart"],
    "only pre-compact running shells are dropped"
  );
});

test("buildShellViews: without a compact boundary, nothing is dropped for staleness", () => {
  const now = 1000_000;
  const shells: ShellRecord[] = [
    { id: "b0qw539vz", command: "npm run dev", status: "running", startedAt: now - 999_000 },
  ];
  assert.equal(buildShellViews(shells, now, undefined).length, 1);
});

test("buildStatusLine: hides shells stranded 'running' across a /compact (bug repro)", () => {
  const fix = path.join(FIX, "shells-stale.jsonl");
  const now = Date.parse("2026-06-15T04:50:00.000Z");
  // liveness undecidable (as if lsof were unavailable) → exercises the compact-staleness fallback.
  const out = buildStatusLine({ transcriptPath: fix, windowSize: 200000, tasks: [], now, isAlive: allUnknown });
  assert.ok(!out.includes("npx vitest --watch"), "pre-compact zombie shell hidden");
  assert.ok(!out.includes("until ! pgrep"), "pre-compact zombie shell hidden");
  assert.ok(out.includes("npm run dev"), "post-compact live shell still shown");
});

test("buildShellViews: drops a running shell whose output file no process holds (UI-kill repro)", () => {
  const now = 1000_000;
  // Both look identical in the transcript (running, no terminal event); only liveness differs.
  const shells: ShellRecord[] = [
    { id: "bkilled01", command: "npx vitest run", status: "running", startedAt: now - 60_000, outputPath: "/t/bkilled01.output" },
    { id: "blive0002", command: "npm run dev", status: "running", startedAt: now - 60_000, outputPath: "/t/blive0002.output" },
  ];
  // killed one has no writer (false), live one does (true).
  const isAlive = (paths: string[]) =>
    new Map(paths.map((p) => [p, p === "/t/blive0002.output"]));
  const views = buildShellViews(shells, now, undefined, isAlive);
  assert.deepEqual(views.map((v) => v.id), ["blive0002"], "UI-killed shell dropped, live one kept");
});

test("buildShellViews: a live shell is kept even if launched before the last /compact", () => {
  const now = 1000_000;
  const compactAt = now - 100_000;
  // Pre-compact → the staleness heuristic alone would drop it, but lsof proves it's alive.
  const shells: ShellRecord[] = [
    { id: "bprecompact", command: "npm run dev", status: "running", startedAt: compactAt - 50_000, outputPath: "/t/bprecompact.output" },
  ];
  const allAlive = (paths: string[]) => new Map(paths.map((p) => [p, true as boolean | undefined]));
  assert.equal(buildShellViews(shells, now, compactAt, allAlive).length, 1, "liveness overrides staleness");
  assert.equal(buildShellViews(shells, now, compactAt, allUnknown).length, 0, "fallback still drops it");
});

test("renderShells: left-rail '<glyph> shell <status> <command…>  <elapsed>', timer flush-right", () => {
  const long = "for i in $(seq 1 999); do echo a-very-long-command-that-overflows-the-line $i; done";
  const lines = renderShells(
    [
      { id: "b0qw539vz", status: "running", command: "npm run dev", ageMs: 230_000 },
      { id: "beelv3a64", status: "running", command: long, ageMs: 9000 },
    ],
    false
  );
  assert.equal(lines.length, 2);
  assert.ok(lines[0].startsWith("┌ shell running npm run dev"), "first shell → ┌ rail glyph");
  assert.ok(lines[0].endsWith("3m 50s"), "elapsed at the right end");
  assert.equal(lines[0].length, 80, "timer right-aligned to wrap width");
  assert.ok(lines[1].startsWith("└ shell running "), "last shell → └ rail glyph");
  assert.ok(lines[1].includes("…"), "long command truncated");
  assert.ok(lines[1].endsWith("9s"), "elapsed still at the right end");
  assert.equal(lines[1].length, 80, "stays within wrap width");
});

test("renderShells: rail glyphs ┌ │ … └ across a group; a lone shell uses └", () => {
  const mk = (n: number) =>
    renderShells(
      Array.from({ length: n }, (_, i) => ({ id: `b${i}`, status: "running", command: `cmd ${i}`, ageMs: 1000 })),
      false
    ).map((l) => l[0]);
  assert.deepEqual(mk(1), ["└"], "lone shell closes the rail");
  assert.deepEqual(mk(3), ["┌", "│", "└"], "first ┌, middle │, last └");
  assert.equal(renderShells([], false).length, 0, "no shells → no lines");
});

test("loadPercent: rounded % of window, null when unknown", () => {
  assert.equal(loadPercent(120000, 200000), 60);
  assert.equal(loadPercent(80000, 200000), 40);
  assert.equal(loadPercent(275000, 1000000), 28);
  assert.equal(loadPercent(100000, 0), null);
});

test("renderMaster: header + 4 components, Tools inline breakdown", () => {
  const v: MasterView = {
    title: "master",
    totalTokens: 142000,
    totalExact: true,
    system: 22700,
    thinking: 60000,
    conversation: 18000,
    tools: { total: 54100, Bash: 38000, Web: 9000, File: 27000 },
  };
  const lines = renderMaster(v, 200000); // color=false → plain gauge + "71%"
  assert.equal(lines.length, 5);
  // 142k/200k = 71% → 7/10 segments filled
  assert.match(lines[0], /^master\s+142\.0k {2}\[█{7}░{3}\] 71%$/);
  assert.match(lines[1], /^- System\s+22\.7k$/);
  assert.match(lines[2], /^- Thinking\s+60\.0k$/);
  assert.match(lines[3], /^- Tools\s+54\.1k\s+Bash 38\.0k \| Web 9\.0k \| File 27\.0k$/);
  assert.match(lines[4], /^- Conversation\s+18\.0k$/);
});

test("buildSubagentView: handoff + real type from matched master Agent", () => {
  // task.type is the generic "local_agent"; real type comes from the match.
  const map = new Map([
    ["find auth", { description: "find auth", prompt: HANDOFF, subagentType: "Explore" }],
  ]);
  const v = buildSubagentView(
    { id: "t1", type: "local_agent", description: "find auth", status: "running", tokenCount: 95000 },
    map
  );
  assert.equal(v.type, "Explore"); // not "local_agent"
  assert.equal(v.description, "find auth");
  assert.equal(v.totalTokens, 95000);
  assert.equal(v.handoff?.text, HANDOFF);
  assert.equal(v.handoff?.tokens, estimateTokens(HANDOFF));
});

test("buildSubagentView: tokenCount 0 → falls back to max tokenSample", () => {
  const v = buildSubagentView(
    { type: "Explore", description: "x", tokenCount: 0, tokenSamples: [0, 4000, 9000] },
    new Map()
  );
  assert.equal(v.totalTokens, 9000);
  assert.equal(v.totalKnown, true);
});

test("buildSubagentView: no count anywhere → totalKnown false (renders '—')", () => {
  const v = buildSubagentView(
    { type: "Explore", description: "x", tokenCount: 0, tokenSamples: [0, 0, 0] },
    new Map()
  );
  assert.equal(v.totalTokens, 0);
  assert.equal(v.totalKnown, false);
  const line = renderSubagent(v, 1000000, false)[0];
  assert.ok(line.includes("—"), "shows em dash");
  assert.ok(!line.includes("0.0k"), "no misleading 0.0k");
  assert.ok(!line.includes("%"), "no fill % when count unknown");
});

test("buildSubagentView: elapsed from matched Agent spawn time, rendered live", () => {
  const now = 5_000_000;
  const map = new Map([
    ["find auth", { description: "find auth", prompt: HANDOFF, subagentType: "Explore", startedAt: now - 110_000 }],
  ]);
  const v = buildSubagentView({ type: "local_agent", description: "find auth", tokenCount: 9000 }, map, now);
  assert.equal(v.ageMs, 110_000); // → "1m 50s"
  const head = renderSubagent(v, 1000000, false)[0];
  assert.ok(head.endsWith("1m 50s"), "elapsed appended to subagent header");
});

test("buildSubagentView: live token total overrides the harness's 0; agentType from meta", () => {
  // The harness reports tokenCount 0 (+ zero samples) for a running subagent; the real
  // total comes from its own transcript's last usage, and the real type from its meta.
  const v = buildSubagentView(
    { id: "t1", type: "local_agent", description: "x", tokenCount: 0, tokenSamples: [0, 0, 0] },
    new Map(),
    1000,
    { tokens: 81677, agentType: "general-purpose" }
  );
  assert.equal(v.totalTokens, 81677);
  assert.equal(v.totalKnown, true);
  assert.equal(v.type, "general-purpose"); // meta wins over "local_agent"
});

test("buildSubagentView: idle from transcript mtime; lastActivity + dotPhase passed through", () => {
  const now = 1_000_000;
  const v = buildSubagentView(
    { id: "t1", type: "local_agent", description: "x", tokenCount: 0 },
    new Map(),
    now,
    { tokens: 5000, mtimeMs: now - 4000, lastActivity: "Edit src/a.ts" },
    2
  );
  assert.equal(v.idleMs, 4000);
  assert.equal(v.lastActivity, "Edit src/a.ts");
  assert.equal(v.dotPhase, 2);
});

test("renderSubagent: live '> activity' line — dots padded to 3 cols, idle flush-right", () => {
  const base = { type: "general-purpose", description: "fix bug", totalTokens: 81677, totalKnown: true } as const;
  const line1 = renderSubagent({ ...base, lastActivity: "Edit src/a.ts", idleMs: 2000, dotPhase: 0 }, 200000, false);
  const activity = line1[line1.length - 1];
  assert.ok(activity.startsWith("> Edit src/a.ts"), "prompt-style marker + activity");
  assert.ok(activity.includes("."), "at least one trailing dot");
  assert.ok(activity.endsWith("idle 2s"), "idle flush-right");
  assert.equal(activity.length, 80, "right-aligned to wrap width");

  // Dot count tracks phase but the idle column stays put (dots padded to 3 cols).
  const at = (phase: number) =>
    renderSubagent({ ...base, lastActivity: "Edit src/a.ts", idleMs: 2000, dotPhase: phase }, 200000, false).pop()!;
  assert.equal(at(0).length, at(1).length, "phase change doesn't shift width");
  assert.equal(at(1).length, at(2).length);
  assert.ok(at(2).includes("..."), "phase 2 → 3 dots");
});

test("renderSubagent: no lastActivity → no live line (header + handoff only)", () => {
  const lines = renderSubagent({ type: "Explore", description: "x", totalTokens: 9000, totalKnown: true }, 200000, false);
  assert.ok(!lines.some((l) => l.startsWith("> ")), "no '>' activity line");
});

test("renderSubagent: activity line is quietly dim — no teal marker, no idle threshold colors", () => {
  const mk = (idleMs: number) =>
    renderSubagent({ type: "x", description: "d", totalTokens: 1, totalKnown: true, lastActivity: "Bash npm test", idleMs }, 200000, true).pop()!;
  for (const idle of [2000, 200_000]) {
    const line = mk(idle);
    assert.ok(line.includes("\x1b[2m"), "the line is dim");
    assert.ok(!line.includes("\x1b[38;5;37m"), "no teal marker");
    assert.ok(!line.includes("\x1b[33m") && !line.includes("\x1b[1;31m"), "no yellow/red idle regardless of duration");
  }
});

test("buildSubagentView: no spawn time anywhere → no elapsed", () => {
  const v = buildSubagentView({ type: "Explore", description: "x", tokenCount: 9000 }, new Map(), 1000);
  assert.equal(v.ageMs, undefined);
  assert.ok(!/\d+s$/.test(renderSubagent(v, 1000000, false)[0]), "no trailing timer");
});

test("buildSubagentView: no match → no handoff (description still in header)", () => {
  const v = buildSubagentView(
    { type: "general-purpose", description: "refactor utils", tokenCount: 12000 },
    new Map()
  );
  assert.equal(v.type, "general-purpose");
  assert.equal(v.description, "refactor utils");
  assert.equal(v.handoff, undefined);
});

test("buildSubagentView: caps handoff at 200 chars with ellipsis", () => {
  const long = "x ".repeat(200).trim(); // 200 words → > 200 chars, wrappable
  const v = buildSubagentView(
    { type: "Explore", description: "big", tokenCount: 1000 },
    new Map([["big", { description: "big", prompt: long, subagentType: "Explore" }]])
  );
  assert.equal(v.handoff?.text.length, 201); // 200 + "…"
  assert.ok(v.handoff?.text.endsWith("…"));
  assert.equal(v.handoff?.tokens, estimateTokens(long)); // size = full prompt
});

test("buildStatusLine: end-to-end master + subagent with matched handoff", () => {
  const out = buildStatusLine({
    transcriptPath: sample,
    windowSize: 200000,
    masterTotal: { tokens: 500, exact: true },
    tasks: [{ id: "t1", type: "local_agent", description: "find auth", status: "running", tokenCount: 95000 }],
  });
  assert.match(out, /^master/m);
  assert.match(out, /^- System/m);
  assert.match(out, /^- Thinking/m);
  assert.match(out, /^- Tools/m);
  assert.match(out, /^subagent · find auth/m); // common label, description preserved
  assert.ok(out.includes("Search the auth module"), "shows matched handoff quote");
  assert.ok(/Search the auth module.*\bsessions\.?"\s+\d+\.\d+k/s.test(out), "handoff size appended at quote end");
  assert.equal(out.split(BLOCK_SEP).length, 2);
});

test("buildStatusLine: master-only when no tasks", () => {
  const out = buildStatusLine({ transcriptPath: sample, windowSize: 200000, tasks: [] });
  assert.equal(out.split(BLOCK_SEP).length, 1, "no subagent block");
  assert.match(out, /^master/m);
});

test("buildStatusLine: master's own shells render as a rail at the foot of the master block", () => {
  const shellsFix = path.join(FIX, "shells.jsonl");
  const now = Date.parse("2026-06-15T04:00:01.000Z") + 230_000; // 3m 50s after b0qw539vz launch
  // The fixture's output paths don't exist on disk; keep liveness undecidable so the
  // transcript-derived status (running/completed/killed) is what's exercised here.
  const out = buildStatusLine({ transcriptPath: shellsFix, windowSize: 200000, tasks: [], now, isAlive: allUnknown });
  const blocks = out.split(BLOCK_SEP);
  assert.equal(blocks.length, 1, "shells nest inside the master block, not a separate block");
  // Two live shells in the fixture → npm run dev is first (┌), timer flush-right.
  assert.match(out, /^┌ shell running npm run dev\s+3m 50s$/m, "first running shell on the rail, timer flush-right");
  assert.match(out, /^└ shell running npx vitest run/m, "last running shell closes the rail");
  assert.ok(!out.includes("sleep 2"), "completed shell hidden");
  assert.ok(!out.includes("for i in 1 2 3"), "killed shell hidden");
  assert.ok(!out.includes("bSPOOF99"), "echoed launch text not shown");
});

test("buildStatusLine: a subagent's own shells render as a rail inside its block", () => {
  // The subagent launches background shells in ITS transcript; inject the per-task lookup
  // (the default reads the subagent transcript from disk) to exercise the wiring + nesting.
  const out = buildStatusLine({
    transcriptPath: sample,
    windowSize: 200000,
    masterTotal: { tokens: 500, exact: true },
    tasks: [{ id: "t1", type: "local_agent", description: "find auth", status: "running", tokenCount: 95000 }],
    subagentShells: (id) =>
      id === "t1"
        ? [
            { id: "bbaseln", status: "running", command: "until grep -q 'Test Files' /tmp/red.log; do :; done", ageMs: 64_000 },
            { id: "bpkill", status: "running", command: "pkill -f '[v]itest'; sleep 2", ageMs: 62_000 },
          ]
        : [],
  });
  const blocks = out.split(BLOCK_SEP);
  assert.equal(blocks.length, 2, "master block + the subagent block (shells nest in the latter)");
  const subBlock = blocks[1];
  assert.match(subBlock, /^subagent · find auth/m);
  // Two shells → ┌ first, └ last, both inside the subagent block.
  assert.match(subBlock, /^┌ shell running until grep/m, "first subagent shell on the rail");
  assert.match(subBlock, /^└ shell running pkill -f/m, "last subagent shell closes the rail");
  // The shells belong to the subagent, not the master block.
  assert.ok(!/^[┌│└] shell/m.test(blocks[0]), "no shell rail in the master block");
});
