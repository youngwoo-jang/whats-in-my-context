import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { parseTranscript } from "../parser";
import { ParseResult } from "../parser/types";

/**
 * parseTranscript wrapped in a tiny mtime+size cache (DESIGN.md §8 — "cache the
 * heavy transcript parse to /tmp"). A status-line tick re-runs every few seconds;
 * the transcript only changes when the session advances, so we re-parse only then.
 */
function cachePath(file: string): string {
  const h = crypto.createHash("sha1").update(file).digest("hex").slice(0, 16);
  return path.join(os.tmpdir(), `wimc-parse-${h}.json`);
}

export function parseTranscriptCached(file: string): ParseResult {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return parseTranscript(file); // missing file → safe empty result
  }
  // CACHE_VERSION guards against schema drift (e.g. a new bucket) — bump it when
  // ParseResult's shape changes so stale-shaped caches are ignored.
  const key = `v6:${stat.mtimeMs}:${stat.size}`;
  const cp = cachePath(file);
  try {
    const cached = JSON.parse(fs.readFileSync(cp, "utf8"));
    if (cached && cached.key === key) return cached.result as ParseResult;
  } catch {
    /* no/!invalid cache — fall through */
  }
  const result = parseTranscript(file);
  try {
    fs.writeFileSync(cp, JSON.stringify({ key, result }));
  } catch {
    /* tmp not writable — just skip caching */
  }
  return result;
}
