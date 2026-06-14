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

A subagent row shows only **total** and **handoff** — its internal component breakdown
is not derivable from official data:

- **total** = the task's `tokenCount`.
- **type** = the real agent type from the matched `Agent` `tool_use.input.subagent_type`
  (subagentStatusLine only reports a generic `local_agent`); falls back to the task's type.
- **description** = the task's `description`.
- **handoff** = the master's `Agent` `tool_use.input.prompt`, matched to the task by
  `description`, capped at **200 characters** with a trailing `…`. Shown only when a
  match exists.

---

## 4. Display

Component order: **System → Thinking → Tools → Conversation**.

- Glyphs are **width-1 ASCII only**. Two constraints force this: statusLine strips
  each line's leading whitespace (so indentation must be a visible character, not
  spaces) and drops blank lines (so blocks are separated by a zero-width-space line),
  and box-drawing / `▸` / `·` are East-Asian "Ambiguous width" (1 column in Latin
  terminals, 2 in CJK), which would break column alignment. Component/handoff rows are
  prefixed `- `; the handoff quote line starts with `"`.
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

Master (the gauge + `62%` is red, `master` is orange):
```
master                    260.5k  [██████░░░░] 62%
- System                   22.7k
- Thinking                156.4k
- Tools                    54.1k   Bash 19.7k | Web 0.0k | File 34.4k
- Conversation             27.4k
```

Subagent (`Explore` is teal):
```
Explore · map all source files   9.2k   1%
"Read every file under /Users/you/project/src AND /Users/you/project/test fully.
For each file produce a detailed paragraph: its responsibility, every exported
symbol, and how it connects to…"  0.1k
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

**`subagentStatusLine` stdin:**
- `tasks[]`, each with `id`, `type`, `status`, `description`, `label`, `startTime`,
  `tokenCount`, `tokenSamples`, `cwd`. No transcript path.

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
- Unknown window size → no danger icon.
- Malformed transcript lines are skipped and counted.
- No handoff match for a subagent → show its `description`.
- Stale or wrong-shaped parse cache → ignored (cache-version tag).
