import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readSubagentLive, resolveDotPhases } from "../src/render/subagent";

/** Build a master transcript + its `<name>/subagents/agent-<id>.{jsonl,meta.json}` tree. */
function scaffold(id: string, opts: { meta?: any; lines?: any[] } = {}): { master: string; jsonl: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wimc-sa-"));
  const name = "sess-" + id;
  const master = path.join(root, name + ".jsonl");
  fs.writeFileSync(master, "{}\n");
  const dir = path.join(root, name, "subagents");
  fs.mkdirSync(dir, { recursive: true });
  if (opts.meta) fs.writeFileSync(path.join(dir, `agent-${id}.meta.json`), JSON.stringify(opts.meta));
  const jsonl = path.join(dir, `agent-${id}.jsonl`);
  if (opts.lines) fs.writeFileSync(jsonl, opts.lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return { master, jsonl };
}

const asst = (content: any[], usage?: any) => ({ type: "assistant", message: { content, ...(usage ? { usage } : {}) } });

test("readSubagentLive: real token total from the LAST assistant usage", () => {
  const { master } = scaffold("aaa111", {
    lines: [
      asst([{ type: "text", text: "early" }], { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 100 }),
      asst([{ type: "text", text: "late" }], { input_tokens: 77, cache_creation_input_tokens: 600, cache_read_input_tokens: 81000 }),
    ],
  });
  const live = readSubagentLive(master, "aaa111");
  assert.equal(live.tokens, 77 + 600 + 81000); // last usage wins, summed like the master
});

test("readSubagentLive: agentType from meta.json", () => {
  const { master } = scaffold("bbb222", { meta: { agentType: "general-purpose", description: "x" }, lines: [asst([{ type: "text", text: "hi" }])] });
  assert.equal(readSubagentLive(master, "bbb222").agentType, "general-purpose");
});

test("readSubagentLive: last activity — text / tool_use / thinking", () => {
  const text = scaffold("c1", { lines: [asst([{ type: "text", text: "  hello world  " }])] });
  assert.equal(readSubagentLive(text.master, "c1").lastActivity, "hello world");

  const tool = scaffold("c2", { lines: [asst([{ type: "tool_use", name: "Edit", input: { file_path: "src/a.ts" } }])] });
  assert.equal(readSubagentLive(tool.master, "c2").lastActivity, "Edit src/a.ts");

  const bash = scaffold("c3", { lines: [asst([{ type: "tool_use", name: "Bash", input: { command: "npm test" } }])] });
  assert.equal(readSubagentLive(bash.master, "c3").lastActivity, "Bash npm test");

  const think = scaffold("c4", { lines: [asst([{ type: "thinking", thinking: "" }])] });
  assert.equal(readSubagentLive(think.master, "c4").lastActivity, "(thinking)");
});

test("readSubagentLive: latest block in the latest turn wins", () => {
  const { master } = scaffold("d1", {
    lines: [
      asst([{ type: "text", text: "first" }]),
      asst([{ type: "tool_use", name: "Read", input: { file_path: "z.ts" } }, { type: "text", text: "after read" }]),
    ],
  });
  assert.equal(readSubagentLive(master, "d1").lastActivity, "after read");
});

test("readSubagentLive: sets mtime; missing files → empty (never throws)", () => {
  const { master, jsonl } = scaffold("e1", { lines: [asst([{ type: "text", text: "x" }])] });
  const live = readSubagentLive(master, "e1");
  assert.equal(live.mtimeMs, fs.statSync(jsonl).mtimeMs);

  assert.deepEqual(readSubagentLive(master, "does-not-exist"), {});
  assert.deepEqual(readSubagentLive("", "e1"), {});
});

test("readSubagentLive: only the tail of a large transcript is read (last usage/activity)", () => {
  // Pad past the 64 KiB tail window so the read starts mid-file (partial first line dropped).
  const filler = Array.from({ length: 400 }, (_, i) =>
    asst([{ type: "text", text: "x".repeat(200) + " line " + i }], { input_tokens: i, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 })
  );
  const { master, jsonl } = scaffold("big1", {
    lines: [
      ...filler,
      asst([{ type: "tool_use", name: "Bash", input: { command: "npm run build" } }], { input_tokens: 1, cache_creation_input_tokens: 2, cache_read_input_tokens: 99000 }),
    ],
  });
  assert.ok(fs.statSync(jsonl).size > 64 * 1024, "fixture exceeds the tail window");
  const live = readSubagentLive(master, "big1");
  assert.equal(live.tokens, 1 + 2 + 99000, "last usage recovered from the tail");
  assert.equal(live.lastActivity, "Bash npm run build");
});

test("resolveDotPhases: advances a step only when mtime grew, else holds", () => {
  const sid = "pulse-" + Math.floor(fs.statSync(__filename).size); // stable-ish per run, isolated key
  // First sighting → phase 0 (1 dot).
  let p = resolveDotPhases(sid, new Map([["t", 1000]]), 10);
  assert.equal(p.get("t"), 0);
  // Same mtime → frozen (hang): still 0.
  p = resolveDotPhases(sid, new Map([["t", 1000]]), 20);
  assert.equal(p.get("t"), 0);
  // mtime grew → +1.
  p = resolveDotPhases(sid, new Map([["t", 1001]]), 30);
  assert.equal(p.get("t"), 1);
  // grew again → +1, and it wraps 2→0.
  p = resolveDotPhases(sid, new Map([["t", 1002]]), 40);
  assert.equal(p.get("t"), 2);
  p = resolveDotPhases(sid, new Map([["t", 1003]]), 50);
  assert.equal(p.get("t"), 0, "wraps 2 → 0");
});

test("resolveDotPhases: empty input is a no-op", () => {
  assert.equal(resolveDotPhases("whatever", new Map(), 1).size, 0);
});
