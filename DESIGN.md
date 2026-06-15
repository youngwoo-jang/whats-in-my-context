# whatsinmycontext — Design Spec

A Claude Code observability tool. It renders, in the status line, a live tree of the
master agent and its subagents — each annotated with its total context tokens and a
breakdown of what fills that context. Fully LLM-free and deterministic; structural
composition only (never semantic).

---

## 1. Architecture — statusLine only

Two scripts, no hooks, no extension:

- **`statusLine`** receives the master's data on stdin and renders the **entire tree**
  (master row + bucket lines + one row per subagent), multi-line.
- **`subagentStatusLine`** receives the live `tasks[]` on stdin, **dumps it to a shared
  file**, and hides the native agent-panel rows by emitting empty content per task.

`statusLine` reads three inputs: its own stdin (master total + window size), the master
transcript JSONL (for the master's component breakdown), and the subagent dump file
(for subagent rows). The heavy transcript parse is cached to a temp file, keyed by the
transcript's mtime + size and a cache-version tag.

---

## 2. The four components (master)

The master's total context is split into four components that **sum to the total**:

| Component        | Definition |
|------------------|------------|
| **System**       | The fixed harness: system prompt + tool / MCP / skill definitions. |
| **Thinking**     | Extended-thinking tokens retained in context. |
| **Tools**        | All tool-call args + results, except `Agent` / `AskUserQuestion`. |
| **Conversation** | Assistant text + user prompts + `Agent` (prompt + return) + `AskUserQuestion` (args + result) + attachments. |

How each is obtained:

- **System** = the **first** assistant turn's usage total (`input` +
  `cache_creation` + `cache_read`). Exact.
- **Tools** and **Conversation** = sum of estimated tokens of their entries
  (a flat ~4 chars/token; approximate, deliberately undercounts dense/non-ASCII text).
- **Thinking** = the residual: `total − System − Tools − Conversation`. Thinking text
  is not stored in the transcript (encrypted in each thinking block's `signature`), so
  it is never measured directly.
- **total** = the **last** assistant turn's usage total (or the master stdin
  `context_window.current_usage` when it is non-zero, which is then authoritative). Exact.

**Compact boundary.** A `/compact` rewrites the context window but does **not** truncate
the transcript file — pre-compact entries remain on disk. So Tools and Conversation are
estimated only over entries **at or after the last `compact_boundary`** (the injected
compact-summary turn is one such entry and counts as Conversation). System (the first
turn's usage) and total (the last turn's usage / `current_usage`) are still read over the
whole file: the harness baseline is constant across a compact, and the last usage is the
current window. This keeps the components summing within the post-compact total instead
of overcounting the discarded history (which would force Thinking to clamp to 0).

**Compact limbo.** Right after a compact, the boundary and summary are on disk but the
first post-compact request has not run yet, so the **last usage is still the stale
pre-compact total** (and `current_usage` is all-zero). Showing it would render the old,
large number until the next turn. So when a `compact_boundary` has **no assistant usage
after it**, total is instead **estimated** as `System + active Tools + active
Conversation` and marked non-exact (rendered with a trailing `?`). The first post-compact
turn writes a real usage entry and total becomes exact again.

Tool → component map (deterministic, by tool name):

| Tool name | Goes to |
|-----------|---------|
| `Bash` | Tools · Bash |
| `WebFetch`, `WebSearch` | Tools · Web |
| `Read`, `Write`, `Edit`, `MultiEdit`, `NotebookEdit`, `Grep`, `Glob` | Tools · File |
| `Agent`, `AskUserQuestion` | Conversation |
| everything else (`mcp__*`, `Skill`, `ToolSearch`, unknown) | Tools (total only) |

The **Tools** line shows a Bash / Web / File sub-breakdown inline; tools outside those
three fold into the Tools total without their own sub-entry.

---

## 3. Subagents

A subagent row shows **total**, **handoff**, and a live **activity** line. Its internal
component breakdown is not derivable, but its own transcript supplies the rest.

The `subagentStatusLine` stdin is nearly useless for a *running* agent: it reports
`tokenCount: 0` (and an all-zero `tokenSamples`) and a generic `local_agent` type for the
**entire run**, and nothing in the payload changes tick-to-tick except the clock. So the
real signals come from the per-subagent transcript the harness writes beside the master at
`<master-dir>/<session>/subagents/agent-<taskId>.jsonl` (+ an `agent-<taskId>.meta.json`
sidecar). The path is derived deterministically from the master `transcript_path` and the
task `id`; only the **tail** (~64 KiB) of the jsonl is read per tick.

- **total** = the subagent's **last assistant `usage`** (input + cache_creation +
  cache_read), exactly as the master total is computed. Falls back to the task's
  `tokenCount` / max `tokenSample`; if all are 0, total is unknown (rendered `—`). This is
  what fixes the long-standing `—` on running subagents.
- **type** = the real `agentType` from `meta.json`; then the matched `Agent`
  `tool_use.input.subagent_type`; then the task's own type (`local_agent`).
- **description** = the task's `description`.
- **handoff** = the master's `Agent` `tool_use.input.prompt`, matched to the task by
  `description`, capped at **200 characters** with a trailing `…`. Shown only when a
  match exists.
- **activity** = the subagent's **last meaningful content block** (assistant text, or a
  `tool_use` rendered `<name> <primary-arg>`, or `(thinking)`), one line, from the tail.
- **idle** = `now − jsonl mtime`: how long since the subagent last wrote anything. This is
  the liveness/hang signal — a deadlocked agent still *exists* but stops writing.

**The pulse (Running… dots).** A status-line script is invoked once per render and exits,
so it can't animate between renders. Instead the activity line's trailing dots advance one
step (`. → .. → …`, padded to a fixed 3 columns so the idle column never jitters) **only on
renders where the transcript mtime grew**, and freeze otherwise. The dots are therefore a
*true* liveness cue — they move iff the agent moved — not a fake spinner. State (last mtime
+ phase per task) is persisted to a tmp pulse file, keyed by session, pruned after 60 s.

---

## 4. Display

Component order: **System → Thinking → Tools → Conversation**.

- Glyphs are **width-1 ASCII** for everything whose column alignment matters. Two
  constraints force this: statusLine strips each line's leading whitespace (so
  indentation must be a visible character, not spaces) and drops blank lines (so blocks
  are separated by a zero-width-space line), and box-drawing / `▸` / `·` are East-Asian
  "Ambiguous width" (1 column in Latin terminals, 2 in CJK), which would break column
  alignment. Component/handoff rows are prefixed `- `; the handoff quote line starts `"`.
  - **Exception — the shell rail.** Background shells render as a left-rail group whose
    glyph marks position: `┌` first, `│` middle, `└` last (a lone shell uses `└`). These
    box-drawing glyphs are LEADING (no indentation — the glyph itself is the left edge,
    surviving the leading-whitespace strip) and the timer is flush-right, so any CJK
    width drift is confined to the left of the text and never compounds. This is a
    deliberate tradeoff for the "contained group" look; Latin terminals are exact.
- Each agent header is `<name>` (master) or `<type> · <description>` (subagent), then
  the total, then the fill %. **Only the name/type is colored** — master **orange**,
  subagents **teal** — leaving the rest plain. (Color is applied without affecting the
  right-aligned token column.)
- Token amounts are right-aligned into a fixed column. Format: `<n>k` with one decimal.
- After the total, the **fill of the context window**: the master shows a 10-segment
  fuel gauge + percent (`[██████░░░░] 62%`); subagents show just the percent. Colored
  by threshold: **≥ 40% yellow, ≥ 60% red** (degradation soft-starts ~40%, compact-by
  ~60%), no color below. The gauge blocks are trailing, so their CJK ambiguous width
  doesn't affect alignment. Window size from stdin
  `context_window.context_window_size`; subagents assume the session window.
- The handoff quote is dim and **word-wrapped to 80 columns** (the 200-char cap yields
  up to ~3 lines); the handoff's token size is appended at the end of the quote.
- Below the handoff, the live **activity line**: `> <last activity><dots>   idle Ns`. The
  `>` reads like a console prompt; the text is hard-truncated (no `…` — the dots imply
  more); the trailing dots are the pulse (§3); `idle Ns` is flush-right at 80 columns. The
  **whole line is uniformly dim** — no marker color, no idle threshold color — so it stays
  quiet beneath the headers (the idle *number* is the hang cue, not a color). Shown only
  when an activity line exists.
- **Shells nest under their owner.** Every live background shell renders as a rail line
  (`<glyph> shell <status> <command…>   <elapsed>`) at the foot of the block of the agent
  that launched it: the master's own shells below its components, and each subagent's
  shells below its activity line. A shell launched *inside* a subagent is recorded only in
  that subagent's transcript (not the master's), so it is parsed from there and attributed
  to the subagent — Claude Code's footer counts these too, which is why a master with one
  busy TDD subagent can show "9 shells" while none were launched at the master level.

Master (the gauge + `62%` is red, `master` is orange):
```
master                    260.5k  [██████░░░░] 62%
- System                   22.7k
- Thinking                156.4k
- Tools                    54.1k   Bash 19.7k | Web 0.0k | File 34.4k
- Conversation             27.4k
```

Subagent (`subagent` and the `>` are teal; the activity is dim, `idle 2s` dim):
```
subagent · map all source files                    9.2k   1m 4s
"Read every file under /Users/you/project/src AND /Users/you/project/test fully.
For each file produce a detailed paragraph: its responsibility, every exported
symbol, and how it connects to…"  0.1k
> Read /Users/you/project/src/parser/index.ts.            idle 2s
```

---

## 5. Data sources

**`statusLine` stdin:**
- `context_window.context_window_size` — the window size.
- `context_window.current_usage` — `{ input_tokens, cache_creation_input_tokens,
  cache_read_input_tokens }`; their sum is the authoritative master total.
- `transcript_path`, `session_id`, `cwd`.

**Master transcript** (`~/.claude/projects/<proj>/<session>.jsonl`, line-delimited JSON):
- Assistant entry `message.usage` — first turn → System, last turn → total.
- Assistant `message.content` blocks are typed: `text`, `thinking`, `tool_use`.
- User `message.content` is either a string (a prompt) or a list of `tool_result` blocks.
- A `tool_result` links to its tool via the result's `tool_use_id` (or the entry's
  `sourceToolAssistantUUID`).
- `Agent` `tool_use.input` carries `subagent_type`, `description`, `prompt`.
- `thinking` blocks store an empty `thinking` field and an encrypted `signature`; their
  token content is unrecoverable.
- Per-block token counts are not stored, so Tools / Conversation are estimated.
- A compact writes a `{ type: "system", subtype: "compact_boundary" }` entry followed by
  a `{ isCompactSummary: true }` user turn holding the summary text.
- A background-shell launch tool_result begins `Command running in background with ID:
  <id>. Output is being written to: <…/tasks/<id>.output>.` — both the id and the output
  path are captured (the path feeds the render-time liveness check).

**`subagentStatusLine` stdin:**
- `tasks[]`, each with `id`, `type`, `status`, `description`, `label`, `startTime`,
  `tokenCount`, `tokenSamples`, `cwd`. No transcript path. For a *running* task,
  `tokenCount` is `0`, `tokenSamples` is all-zero, and `type` is `local_agent` — none of it
  changes tick-to-tick. The live signals come from the subagent transcript instead.

**Subagent transcript** (`<master-dir>/<session>/subagents/agent-<taskId>.jsonl` +
`agent-<taskId>.meta.json`): the per-subagent conversation, path derived from the master
`transcript_path` + task `id`. Only the tail (~64 KiB) is read per tick.
- Last assistant `message.usage` → the real running **total**.
- Last meaningful `message.content` block → the **activity** line.
- `meta.json` `agentType` → the real **type**.
- File **mtime** → **idle** (last sign of life) and the pulse step (§3).
- Background-shell launch echoes → the shells the subagent itself spawned. Every entry in
  a subagent transcript is `isSidechain: true`, so (unlike the master parse) the sidechain
  filter is NOT applied when extracting these — otherwise all of them would be dropped. The
  whole file is read for this (a shell launched early can still be running), with the same
  mtime+size cache as the master parse. Liveness is the same OS check as master shells (§7).

**OS (render time):** a background shell's `tasks/<id>.output` file (held open by the shell
for its lifetime; `lsof` confirms liveness — see §7, UI-kill handling) and each running
subagent's `agent-<taskId>.jsonl` mtime, both stat'd per tick for liveness.

---

## 6. Distribution

Public npm, standalone **npx one-shot installer** (not a plugin).

- `npx -y whatsinmycontext init` runs once: copies the compiled scripts to
  `~/.claude/whatsinmycontext` and writes both `statusLine` and `subagentStatusLine`
  into `~/.claude/settings.json`, pointing them at the local `node` script (no per-tick
  `npx`).
- If a `statusLine` already exists, it is **chained** (the existing command runs first,
  this tree renders below) unless `--force` overwrites it.
- `npx whatsinmycontext@latest upgrade` re-copies the scripts; `uninstall` removes the
  entries (restoring a chained predecessor) and the install dir.
- Existing `settings.json` is backed up before writing; unparseable settings abort the
  install rather than being clobbered.

---

## 7. Edge cases

- Missing or unreadable transcript / settings → safe empty result; never throw on a tick.
- No assistant usage → System and total are 0, no danger icon.
- Just after a compact, before the first new turn, `current_usage` can be present but
  all-zero; it is ignored (treated as absent) so total falls back to the last usage
  rather than reading 0.
- After a compact, Tools / Conversation are estimated only from the active segment (since
  the last `compact_boundary`); pre-compact history on disk is not counted.
- In compact limbo (a `compact_boundary` with no assistant usage after it), the stale
  pre-compact last-usage is not used as total; total is estimated from the active segment
  and marked non-exact (`?`) until the first post-compact turn issues a real usage.
- A background shell **killed from the UI** (the X button) emits no transcript signal —
  no `TaskStop`/`KillShell`, no `task-notification <status>` — so transcript parsing alone
  would pin it `running` forever and over-count. Liveness is therefore confirmed at the OS
  level: the harness redirects a shell's stdout/stderr to its `tasks/<id>.output` file for
  the life of the process (the wrapping `zsh -c '…' > <id>.output` keeps the file open even
  when the inner command redirects its own output), so a `running` shell is dropped unless
  some process holds that file open **for write**. The path is captured from the launch
  echo; a single batched `lsof -Fan` per render decides all running shells at once, and
  verdicts are cached (~2 s TTL) so back-to-back renders don't re-spawn it. Requiring a
  *write* holder (not just any) means a mere reader — `tail -f` on the output, an editor —
  doesn't read as alive, while an inherited writer (a worker child of the shell) correctly
  does. Unlike an mtime cutoff this stays correct for a *quiet but live* process (a dev
  server, `vitest` between files), whose write fd is still open with no recent writes. The
  probe is fail-safe: if `lsof` is missing or times out it returns "unknown" and the shell
  falls back to the `compact_boundary` staleness guard (drop if launched before the last
  `/compact`) rather than being hidden on a false reading. See
  `BUGREPORT-auto-background-shells.md`.
- Unknown window size → no danger icon.
- Malformed transcript lines are skipped and counted.
- No handoff match for a subagent → show its `description`.
- Stale or wrong-shaped parse cache → ignored (cache-version tag).
