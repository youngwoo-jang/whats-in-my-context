import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as path from "path";
import { formatTokens, loadPercent, renderMaster, renderSubagent, MasterView, BLOCK_SEP } from "../src/render/format";
import { buildSubagentView, buildStatusLine } from "../src/render/build";
import { estimateTokens } from "../src/parser";

const FIX = path.join(__dirname, "..", "..", "test", "fixtures");
const sample = path.join(FIX, "sample-session.jsonl");

const HANDOFF = "Search the auth module and list every file touching sessions.";

test("formatTokens: compact k, one decimal", () => {
  assert.equal(formatTokens(142000), "142.0k");
  assert.equal(formatTokens(500), "0.5k");
  assert.equal(formatTokens(undefined as any), "0.0k"); // defensive
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
  assert.match(out, /^Explore · find auth/m); // type resolved from matched Agent, no ">" marker
  assert.ok(out.includes("Search the auth module"), "shows matched handoff quote");
  assert.ok(/Search the auth module.*\bsessions\.?"\s+\d+\.\d+k/s.test(out), "handoff size appended at quote end");
  assert.equal(out.split(BLOCK_SEP).length, 2);
});

test("buildStatusLine: master-only when no tasks", () => {
  const out = buildStatusLine({ transcriptPath: sample, windowSize: 200000, tasks: [] });
  assert.equal(out.split(BLOCK_SEP).length, 1, "no subagent block");
  assert.match(out, /^master/m);
});
