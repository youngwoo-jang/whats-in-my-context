#!/usr/bin/env node
import { readStdin } from "../render/stdin";
import { writeTasks } from "../render/dump";

/**
 * subagentStatusLine hook: dump the live `tasks[]` to the shared file (so the
 * master statusLine can render the whole tree) and HIDE the native agent-panel
 * rows by emitting empty content per task (DESIGN.md §2).
 */
async function main(): Promise<void> {
  let data: any = {};
  try {
    data = JSON.parse(await readStdin());
  } catch {
    /* no/invalid input */
  }
  const sessionId = data.session_id || "default";
  const tasks = Array.isArray(data.tasks) ? data.tasks : [];
  writeTasks(sessionId, tasks);
  const out = tasks.map((t: any) => JSON.stringify({ id: t.id, content: "" })).join("\n");
  process.stdout.write(out);
}

main();
