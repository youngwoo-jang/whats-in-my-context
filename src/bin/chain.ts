#!/usr/bin/env node
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { readStdin } from "../render/stdin";
import { renderFromStatusJSON } from "../render/build";

/**
 * statusLine CHAIN wrapper. When the user already had a statusLine command, the
 * installer points statusLine at this script and records the previous command in
 * `<installDir>/prev-statusline.txt`. We buffer stdin once, feed it to the
 * previous command, then print its output followed by our tree below.
 * Layout: dist/src/bin/chain.js → installDir is three levels up.
 */
const INSTALL_DIR = path.join(__dirname, "..", "..", "..");
const PREV_FILE = path.join(INSTALL_DIR, "prev-statusline.txt");

async function main(): Promise<void> {
  const raw = await readStdin();

  let prevOut = "";
  try {
    const prevCmd = fs.readFileSync(PREV_FILE, "utf8").trim();
    if (prevCmd) {
      prevOut = execSync(prevCmd, { input: raw, encoding: "utf8", timeout: 5000 });
    }
  } catch {
    /* no previous command, or it failed — skip it */
  }

  let data: any = {};
  try {
    data = JSON.parse(raw);
  } catch {
    /* ignore */
  }
  const ours = renderFromStatusJSON(data, true);

  const parts = [prevOut.replace(/\n+$/, ""), ours].filter((s) => s.length > 0);
  process.stdout.write(parts.join("\n"));
}

main();
