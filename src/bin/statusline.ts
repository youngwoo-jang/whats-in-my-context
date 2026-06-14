#!/usr/bin/env node
import { readStdin } from "../render/stdin";
import { renderFromStatusJSON } from "../render/build";

/**
 * statusLine hook: render the full master+subagents tree (DESIGN.md §2/§4).
 * Master total comes from `context_window.current_usage`; master buckets from
 * parsing `transcript_path`; subagents from the shared dump.
 */
async function main(): Promise<void> {
  let data: any = {};
  try {
    data = JSON.parse(await readStdin());
  } catch {
    /* no/invalid input → render nothing */
  }
  process.stdout.write(renderFromStatusJSON(data, true));
}

main();
