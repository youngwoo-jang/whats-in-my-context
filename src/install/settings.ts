/** Pure settings-merge planning for the installer (no filesystem I/O — testable). */

export interface StatusLineEntry {
  type: string;
  command: string;
  refreshInterval?: number;
  padding?: number;
  [k: string]: any;
}

export interface InstallPlan {
  /** the new settings object to write. */
  settings: any;
  /** previous statusLine command to persist for chaining, or null. */
  prevCommand: string | null;
  /** human-readable summary of what changed. */
  actions: string[];
}

const MARKER = "whatsinmycontext";

/** The command Claude Code should run for a given compiled bin. */
export function commandFor(installDir: string, script: string): string {
  return `node ${installDir}/dist/src/bin/${script}`;
}

function isOurs(cmd: unknown): boolean {
  return typeof cmd === "string" && cmd.includes(MARKER);
}

/**
 * Plan the settings.json changes for `init`/`upgrade`.
 *  - subagentStatusLine → always ours (dumps tasks, hides native rows).
 *  - statusLine → set if absent; update in place if already ours; if a *different*
 *    third-party statusLine exists, CHAIN it (run theirs, our tree below) unless
 *    `force` is set (then overwrite).
 */
export function planInstall(
  existing: any,
  installDir: string,
  opts: { force?: boolean } = {}
): InstallPlan {
  const settings = { ...(existing && typeof existing === "object" ? existing : {}) };
  const actions: string[] = [];
  let prevCommand: string | null = null;

  const statusCmd = commandFor(installDir, "statusline.js");
  const subCmd = commandFor(installDir, "subagent-statusline.js");
  const chainCmd = commandFor(installDir, "chain.js");

  // --- subagentStatusLine: always ours ---
  const curSub = settings.subagentStatusLine;
  if (curSub && curSub.command && !isOurs(curSub.command)) {
    actions.push(`replaced subagentStatusLine (was: ${curSub.command})`);
  }
  settings.subagentStatusLine = { type: "command", command: subCmd };

  // --- statusLine: set / update / chain / overwrite ---
  const cur: StatusLineEntry | undefined = settings.statusLine;
  if (!cur || !cur.command) {
    settings.statusLine = { type: "command", command: statusCmd, refreshInterval: 2 };
    actions.push("set statusLine");
  } else if (isOurs(cur.command)) {
    // already installed — re-point to the right script, keep refreshInterval.
    const keepChain = cur.command.includes("chain.js");
    settings.statusLine = { ...cur, type: "command", command: keepChain ? chainCmd : statusCmd };
    actions.push("updated existing whatsinmycontext statusLine");
  } else if (opts.force) {
    actions.push(`overwrote statusLine (was: ${cur.command})`);
    settings.statusLine = { type: "command", command: statusCmd, refreshInterval: cur.refreshInterval ?? 2 };
  } else {
    prevCommand = cur.command;
    settings.statusLine = { type: "command", command: chainCmd, refreshInterval: cur.refreshInterval ?? 2 };
    actions.push(`chained existing statusLine (yours runs first, our tree renders below): ${cur.command}`);
  }

  return { settings, prevCommand, actions };
}
