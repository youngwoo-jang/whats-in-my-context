import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/** Liveness verdict for a shell's output file. */
export type Liveness = boolean | undefined; // true=alive, false=dead, undefined=undecidable

const CACHE_FILE = path.join(os.tmpdir(), "wimc-shell-liveness.json");
const CACHE_TTL_MS = 2000; // a status line doesn't need sub-second liveness accuracy

/**
 * Batched, cached liveness for a set of background-shell `tasks/<id>.output` paths.
 *
 * Why this works: the harness redirects a shell's stdout/stderr to its `.output` file for
 * the life of the process (the wrapping `zsh -c 'eval cmd …' > <id>.output` keeps the file
 * open even when the inner command redirects its own output elsewhere — verified), so a
 * process holding that file open for WRITE means the shell is alive. This is the only signal
 * that catches a shell killed from the Claude Code UI, which writes nothing to the
 * transcript. Unlike an mtime cutoff it stays correct for a quiet-but-live process (its fd
 * is still open with no recent writes).
 *
 * Hardening (per review):
 *  - ONE `lsof` invocation for the whole set, not one per shell.
 *  - WRITE access only: a mere reader (`tail -f` on the output, an editor) does not count
 *    as alive; an inherited writer (a child worker of the shell) correctly does.
 *  - Verdicts cached to tmp with a short TTL so back-to-back renders don't re-spawn lsof.
 *
 * Returns a map path → true | false | undefined; an undecidable path (no lsof, timeout)
 * is left for the caller to fall back on.
 */
export function probeShellLiveness(paths: string[]): Map<string, Liveness> {
  const want = [...new Set(paths.filter((p): p is string => typeof p === "string" && p.length > 0))];
  if (!want.length) return new Map();

  // Fresh cache covering every requested path → reuse without spawning lsof.
  const cached = readCache();
  if (cached && want.every((p) => p in cached)) {
    return new Map(want.map((p) => [p, cached[p] as Liveness]));
  }

  const writers = lsofWriters(want);
  if (!writers) {
    // lsof unusable (missing / timed out) → undecidable for all; don't poison the cache.
    return new Map(want.map((p) => [p, undefined]));
  }
  const verdict: Record<string, boolean> = {};
  for (const p of want) verdict[p] = writers.has(p);
  writeCache(verdict);
  return new Map(want.map((p) => [p, verdict[p]]));
}

/**
 * Run `lsof` once over `paths` and return the set of paths held open for WRITE, or null
 * if lsof couldn't be used at all (not installed / timed out) so the caller reports
 * "undecidable" rather than a false "dead".
 */
function lsofWriters(paths: string[]): Set<string> | null {
  try {
    // -F a,n → machine-readable: access mode + file name per open file. `--` guards a
    // path that looks like a flag (paths come from parsed transcript text, never a shell).
    const out = execFileSync("lsof", ["-Fan", "--", ...paths], {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    });
    return parseWriters(out.toString());
  } catch (e: any) {
    if (e && e.code === "ENOENT") return null; // lsof not on PATH
    if (e && (e.killed || e.signal)) return null; // timed out / signalled
    // Non-zero exit just means "no holder for (some of) these" — lsof still printed the
    // ones it found on stdout. Parse that; absent paths fall out as dead.
    if (e && typeof e.status === "number") return parseWriters((e.stdout || "").toString());
    return null;
  }
}

/** Parse `lsof -Fan` output → set of file names open for write (`w`) or read-write (`u`). */
function parseWriters(out: string): Set<string> {
  const writers = new Set<string>();
  let access = "";
  for (const line of out.split("\n")) {
    const tag = line[0];
    if (tag === "f") access = ""; // new open-file block; access field follows
    else if (tag === "a") access = line.slice(1);
    else if (tag === "n" && (access.includes("w") || access.includes("u"))) writers.add(line.slice(1));
  }
  return writers;
}

function readCache(): Record<string, boolean> | null {
  try {
    if (Date.now() - fs.statSync(CACHE_FILE).mtimeMs > CACHE_TTL_MS) return null;
    const d = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    return d && typeof d === "object" && d.v && typeof d.v === "object" ? d.v : null;
  } catch {
    return null; // no / unreadable / stale cache
  }
}

function writeCache(v: Record<string, boolean>): void {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ v }));
  } catch {
    /* tmp not writable — just skip caching */
  }
}
