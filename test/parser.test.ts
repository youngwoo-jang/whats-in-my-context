import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as path from "path";
import { parseTranscript, computeThinking, estimateTokens, laneForTool } from "../src/parser/index";

const FIX = path.join(__dirname, "..", "..", "test", "fixtures");
const sample = path.join(FIX, "sample-session.jsonl");
const synthetic = path.join(FIX, "synthetic.jsonl");
const malformed = path.join(FIX, "malformed.jsonl");

test("estimateTokens: char/4 rounded up", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens(null), 0);
  assert.equal(estimateTokens("1234"), 1);
  assert.equal(estimateTokens("12345"), 2);
});

test("laneForTool: deterministic tool → lane", () => {
  assert.equal(laneForTool("Bash"), "Bash");
  assert.equal(laneForTool("WebSearch"), "Web");
  assert.equal(laneForTool("WebFetch"), "Web");
  assert.equal(laneForTool("Edit"), "File");
  assert.equal(laneForTool("Grep"), "File");
  assert.equal(laneForTool("Agent"), "Conversation");
  assert.equal(laneForTool("AskUserQuestion"), "Conversation");
  assert.equal(laneForTool("mcp__x__y"), "ToolsMisc");
  assert.equal(laneForTool("Skill"), "ToolsMisc");
  assert.equal(laneForTool(undefined), "ToolsMisc");
});

test("computeThinking: residual, clamped at 0", () => {
  assert.equal(computeThinking(500, 100, 103, 57), 240);
  assert.equal(computeThinking(6, 6, 24, 0), 0); // estimates exceed total → clamp
});

test("parseTranscript: synthetic exact components", () => {
  const r = parseTranscript(synthetic);
  assert.equal(r.totalExact, true);
  assert.equal(r.totalTokens, 6); // only usage entry = first = last
  assert.equal(r.systemTokens, 6);
  assert.equal(r.systemExact, true);
  assert.deepEqual(r.tools, { total: 24, Bash: 6, Web: 4, File: 9 }); // misc(mcp)=5 in total only
  assert.equal(r.conversation, 0);
});

test("parseTranscript: sample — System(first) ≠ total(last), components close to total", () => {
  const r = parseTranscript(sample);
  assert.equal(r.systemTokens, 100); // a1 usage 1+99+0
  assert.equal(r.totalTokens, 500); // a5 usage 7+13+480
  assert.equal(r.tools.total, 103);
  assert.equal(r.tools.Bash, 11);
  assert.equal(r.tools.Web, 20);
  assert.equal(r.tools.File, 65);
  assert.equal(r.conversation, 57);
  assert.equal(r.entryCount, 11);
  const thinking = computeThinking(r.totalTokens, r.systemTokens, r.tools.total, r.conversation);
  assert.equal(r.systemTokens + thinking + r.tools.total + r.conversation, r.totalTokens);
});

test("parseTranscript: collects Agent handoffs", () => {
  const r = parseTranscript(sample);
  assert.equal(r.agentHandoffs.length, 1);
  assert.equal(r.agentHandoffs[0].description, "find auth");
  assert.match(r.agentHandoffs[0].prompt, /^Search the auth module/);
});

test("malformed.jsonl: skips bad lines, computes from valid usage", () => {
  const r = parseTranscript(malformed);
  assert.ok(r.skippedLines >= 1);
  assert.equal(r.totalTokens, 115); // a1 usage 10+5+100
  assert.equal(r.systemTokens, 115);
  assert.ok(r.tools.File > 0, "Read args + result → File");
});

test("sidechain (subagent) entries are excluded from the master parse", () => {
  // a1 usage 100 (first), a2 usage 200 (last); the isSidechain entries (usage 27000,
  // a Read tool_use + its result) must NOT leak into System/total/Tools.
  const r = parseTranscript(path.join(FIX, "sidechain.jsonl"));
  assert.equal(r.systemTokens, 100); // a1, not the sidechain's 27000
  assert.equal(r.totalTokens, 200); // a2, not the sidechain
  assert.ok(r.tools.Bash > 0, "master's Bash counted");
  assert.equal(r.tools.File, 0, "sidechain Read NOT counted");
  assert.ok(r.conversation > 0, "master 'done' text counted");
});

test("compact: estimates only the active segment; System/total span the file", () => {
  // a1 usage 100 (first → System), a2 usage 300 (last → total). A compact_boundary
  // sits between them; the pre-compact Bash tool_use + result must NOT be counted,
  // the post-compact Read must be, and the compact summary counts as Conversation.
  const r = parseTranscript(path.join(FIX, "compact.jsonl"));
  assert.equal(r.systemTokens, 100); // first usage, whole file
  assert.equal(r.totalTokens, 300); // last usage, whole file
  assert.equal(r.tools.Bash, 0, "pre-compact Bash excluded from active segment");
  assert.ok(r.tools.File > 0, "post-compact Read counted");
  assert.ok(r.conversation > 0, "compact summary + post-compact text counted");
  // The whole point: active components stay within the total (no Thinking clamp).
  assert.ok(
    r.systemTokens + r.tools.total + r.conversation <= r.totalTokens,
    "active components sum within total"
  );
});

test("compact limbo: no usage after the boundary → total is estimated, non-exact", () => {
  // a1 holds the only (pre-compact) usage = 100, then a compact_boundary + summary with
  // NO assistant usage after it. The stale 100 must NOT be the total; instead total is
  // estimated from the active segment (System + active components) and marked non-exact.
  const r = parseTranscript(path.join(FIX, "compact-limbo.jsonl"));
  assert.equal(r.systemTokens, 100); // first/only usage, whole file
  assert.equal(r.totalExact, false, "limbo total is an estimate, not exact");
  assert.equal(r.tools.Bash, 0, "pre-compact Bash excluded from active segment");
  assert.ok(r.conversation > 0, "compact summary counts as Conversation");
  assert.equal(
    r.totalTokens,
    r.systemTokens + r.tools.total + r.conversation,
    "total = System + active components (not the stale pre-compact usage)"
  );
  assert.ok(r.totalTokens > 100, "estimate exceeds the stale pre-compact total");
});

test("missing file: safe empty result, no throw", () => {
  const r = parseTranscript(path.join(FIX, "nope.jsonl"));
  assert.equal(r.totalTokens, 0);
  assert.equal(r.totalExact, false);
  assert.equal(r.systemTokens, 0);
  assert.equal(r.entryCount, 0);
  assert.deepEqual(r.tools, { total: 0, Bash: 0, Web: 0, File: 0 });
  assert.equal(r.conversation, 0);
  assert.deepEqual(r.agentHandoffs, []);
});
