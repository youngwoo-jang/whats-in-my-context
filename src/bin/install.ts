#!/usr/bin/env node
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { planInstall } from "../install/settings";

// Layout: <pkg>/dist/src/bin/install.js → <pkg> is three levels up.
const PKG_ROOT = path.join(__dirname, "..", "..", "..");
const SRC_DIST = path.join(PKG_ROOT, "dist");

const CLAUDE_DIR = path.join(os.homedir(), ".claude");
const INSTALL_DIR = path.join(CLAUDE_DIR, "whatsinmycontext");
const SETTINGS = path.join(CLAUDE_DIR, "settings.json");
const PREV_FILE = path.join(INSTALL_DIR, "prev-statusline.txt");

function readJSON(p: string): any {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return undefined;
  }
}

function copyDist(): void {
  fs.mkdirSync(INSTALL_DIR, { recursive: true });
  fs.cpSync(SRC_DIST, path.join(INSTALL_DIR, "dist"), { recursive: true });
}

function init(force: boolean): void {
  if (!fs.existsSync(path.join(SRC_DIST, "src", "bin", "statusline.js"))) {
    console.error("error: compiled scripts not found in the package (expected dist/). Build first.");
    process.exit(1);
  }

  // Parse existing settings; refuse to clobber an unparseable file.
  let existing = readJSON(SETTINGS);
  if (existing === undefined && fs.existsSync(SETTINGS)) {
    console.error(`error: ${SETTINGS} is not valid JSON; aborting so it isn't clobbered.`);
    process.exit(1);
  }
  if (existing === undefined) existing = {};

  copyDist();
  const plan = planInstall(existing, INSTALL_DIR, { force });

  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  if (fs.existsSync(SETTINGS)) fs.copyFileSync(SETTINGS, SETTINGS + ".wimc.bak");
  if (plan.prevCommand) fs.writeFileSync(PREV_FILE, plan.prevCommand);
  fs.writeFileSync(SETTINGS, JSON.stringify(plan.settings, null, 2) + "\n");

  console.log("✓ whatsinmycontext installed");
  plan.actions.forEach((a) => console.log("  - " + a));
  console.log(`\n  scripts:  ${INSTALL_DIR}/dist`);
  console.log(`  settings: ${SETTINGS}` + (fs.existsSync(SETTINGS + ".wimc.bak") ? " (backup: .wimc.bak)" : ""));
  console.log("\nClaude Code will pick up the new status line on the next tick.");
}

function uninstall(): void {
  const existing = readJSON(SETTINGS) || {};
  const actions: string[] = [];

  const sl = existing.statusLine;
  if (sl && typeof sl.command === "string" && sl.command.includes("whatsinmycontext")) {
    if (fs.existsSync(PREV_FILE)) {
      existing.statusLine = { type: "command", command: fs.readFileSync(PREV_FILE, "utf8").trim() };
      actions.push("restored previous statusLine");
    } else {
      delete existing.statusLine;
      actions.push("removed statusLine");
    }
  }
  const ssl = existing.subagentStatusLine;
  if (ssl && typeof ssl.command === "string" && ssl.command.includes("whatsinmycontext")) {
    delete existing.subagentStatusLine;
    actions.push("removed subagentStatusLine");
  }

  if (fs.existsSync(SETTINGS)) fs.copyFileSync(SETTINGS, SETTINGS + ".wimc.bak");
  fs.writeFileSync(SETTINGS, JSON.stringify(existing, null, 2) + "\n");
  try {
    fs.rmSync(INSTALL_DIR, { recursive: true, force: true });
    actions.push(`removed ${INSTALL_DIR}`);
  } catch {
    /* ignore */
  }

  console.log("✓ whatsinmycontext uninstalled");
  actions.forEach((a) => console.log("  - " + a));
}

const cmd = process.argv[2] || "init";
const force = process.argv.includes("--force");
switch (cmd) {
  case "init":
  case "upgrade":
    init(force);
    break;
  case "uninstall":
    uninstall();
    break;
  default:
    console.log("usage: whatsinmycontext <init|upgrade|uninstall> [--force]");
}
