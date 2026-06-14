import { test } from "node:test";
import * as assert from "node:assert/strict";
import { planInstall, commandFor } from "../src/install/settings";

const DIR = "/home/me/.claude/whatsinmycontext";
const STATUS = commandFor(DIR, "statusline.js");
const SUB = commandFor(DIR, "subagent-statusline.js");
const CHAIN = commandFor(DIR, "chain.js");

test("fresh install: sets both status lines, no chaining", () => {
  const p = planInstall({}, DIR);
  assert.equal(p.settings.statusLine.command, STATUS);
  assert.equal(p.settings.statusLine.refreshInterval, 2);
  assert.equal(p.settings.subagentStatusLine.command, SUB);
  assert.equal(p.prevCommand, null);
});

test("preserves unrelated settings keys", () => {
  const p = planInstall({ theme: "dark", permissions: { allow: ["Bash"] } }, DIR);
  assert.equal(p.settings.theme, "dark");
  assert.deepEqual(p.settings.permissions, { allow: ["Bash"] });
});

test("existing third-party statusLine: chains it (keeps theirs, ours below)", () => {
  const existing = { statusLine: { type: "command", command: "~/bin/ccstatusline.sh", refreshInterval: 5 } };
  const p = planInstall(existing, DIR);
  assert.equal(p.settings.statusLine.command, CHAIN);
  assert.equal(p.settings.statusLine.refreshInterval, 5, "carries over their refreshInterval");
  assert.equal(p.prevCommand, "~/bin/ccstatusline.sh");
  assert.ok(p.actions.some((a) => a.includes("chained")));
});

test("--force overwrites a third-party statusLine instead of chaining", () => {
  const existing = { statusLine: { type: "command", command: "~/bin/other.sh" } };
  const p = planInstall(existing, DIR, { force: true });
  assert.equal(p.settings.statusLine.command, STATUS);
  assert.equal(p.prevCommand, null);
  assert.ok(p.actions.some((a) => a.includes("overwrote")));
});

test("re-run when already installed: updates in place, no new prev", () => {
  const existing = { statusLine: { type: "command", command: STATUS, refreshInterval: 3 } };
  const p = planInstall(existing, DIR);
  assert.equal(p.settings.statusLine.command, STATUS);
  assert.equal(p.settings.statusLine.refreshInterval, 3, "keeps existing refreshInterval");
  assert.equal(p.prevCommand, null);
});

test("re-run when already chained: keeps the chain wrapper", () => {
  const existing = { statusLine: { type: "command", command: CHAIN, refreshInterval: 2 } };
  const p = planInstall(existing, DIR);
  assert.equal(p.settings.statusLine.command, CHAIN);
  assert.equal(p.prevCommand, null);
});

test("replaces a foreign subagentStatusLine", () => {
  const existing = { subagentStatusLine: { type: "command", command: "~/bin/theirs.sh" } };
  const p = planInstall(existing, DIR);
  assert.equal(p.settings.subagentStatusLine.command, SUB);
  assert.ok(p.actions.some((a) => a.includes("replaced subagentStatusLine")));
});
