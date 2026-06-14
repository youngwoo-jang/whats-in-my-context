import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * One subagent task as emitted in the `subagentStatusLine` stdin `tasks[]`.
 * Loosely typed — Claude Code's exact schema can drift, so every field is optional.
 */
export interface SubagentTask {
  id?: string;
  type?: string;
  label?: string;
  name?: string;
  description?: string;
  status?: string;
  tokenCount?: number;
  /** per-tick token readings; the max is used when tokenCount lags at 0 (build.ts). */
  tokenSamples?: number[];
  startTime?: number;
  [k: string]: any;
}

const FINISHED = new Set(["completed", "failed", "cancelled", "error", "done"]);

/** Shared dump file: subagentStatusLine writes it, statusLine reads it. */
export function dumpPath(sessionId: string): string {
  const safe = (sessionId || "default").replace(/[^a-zA-Z0-9_-]/g, "") || "default";
  return path.join(os.tmpdir(), `wimc-subagents-${safe}.json`);
}

export function writeTasks(sessionId: string, tasks: SubagentTask[]): void {
  try {
    fs.writeFileSync(dumpPath(sessionId), JSON.stringify({ tasks }));
  } catch {
    /* tmp not writable — nothing to render, degrade to master-only */
  }
}

/**
 * Read live subagent tasks. Returns [] when the dump is missing or stale (older
 * than maxAgeMs — meaning no subagentStatusLine tick recently, i.e. no live
 * subagents), and filters out finished tasks.
 */
export function readTasks(sessionId: string, maxAgeMs = 15000): SubagentTask[] {
  const p = dumpPath(sessionId);
  try {
    const stat = fs.statSync(p);
    if (Date.now() - stat.mtimeMs > maxAgeMs) return [];
    const data = JSON.parse(fs.readFileSync(p, "utf8"));
    const tasks: SubagentTask[] = Array.isArray(data?.tasks) ? data.tasks : [];
    return tasks.filter((t) => !FINISHED.has((t.status || "").toLowerCase()));
  } catch {
    return [];
  }
}
