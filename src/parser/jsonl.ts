import * as fs from "fs";

export interface JsonlReadResult {
  /** parsed entries (loosely typed — schema drifts; access every field defensively). */
  entries: any[];
  skippedLines: number;
}

/**
 * Robustly read a line-delimited JSON transcript. Malformed lines are skipped
 * and counted (transcripts can have a truncated final line while live). A
 * missing/unreadable file yields an empty result rather than throwing — this
 * runs on a status-line tick and must never crash.
 */
export function readJsonl(filePath: string): JsonlReadResult {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return { entries: [], skippedLines: 0 };
  }
  const entries: any[] = [];
  let skippedLines = 0;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      skippedLines++;
    }
  }
  return { entries, skippedLines };
}
