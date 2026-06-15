# whatsinmycontext

A tiny **Claude Code** observability tool. It turns the status line into a live tree
of the master agent and its subagents — each annotated with its **total context
tokens** and a breakdown of **what's filling that context** — so you can see, at a
glance, whether your context is under control.

```
master                    260.5k  [██████░░░░] 62%
- System                   22.7k
- Thinking                156.4k
- Tools                    54.1k   Bash 19.7k | Web 0.0k | File 34.4k
- Conversation             27.4k

Explore · map all source files   9.2k   1%
"Read every file under src and test fully. For each file produce a detailed
paragraph: its responsibility, every exported symbol…"  0.1k
```

- The number by each agent is its **exact total context** (from usage).
- The master splits into **four components that sum to the total** — so a large
  `Thinking` or `System` slice tells you *directly* what's eating the window:
  - **System** — the fixed harness (system prompt + tool/MCP/skill definitions),
    measured from the first turn.
  - **Thinking** — extended-thinking tokens (a residual; thinking text is encrypted
    in the transcript and can't be measured directly, so this reads as an upper bound).
  - **Tools** — tool args + results, with a `Bash | Web | File` sub-breakdown.
  - **Conversation** — your prompts, the assistant's text, and sub-agent handoffs.
- The trailing **fuel gauge + %** is the fill of the context window, colored
  **yellow ≥ 40%** and **red ≥ 60%** (degradation soft-starts ~40%, compact-by ~60%).
- Each **subagent** shows its type · description, total, and the handoff it received
  from the master (matched by description, capped at 200 chars).

It's fully **LLM-free**, deterministic, and **zero runtime dependencies** — everything
is keyed on entry type, block type, and tool name. See
[DESIGN.md](./DESIGN.md) for the authoritative spec and rationale.

## Requirements

- **Node 18+** (uses `fs.cpSync`/`fs.rmSync`).
- **Claude Code** with a `~/.claude/settings.json` (the installer writes there).

## Install

One command writes the `statusLine` + `subagentStatusLine` into your
`~/.claude/settings.json` and copies the scripts to `~/.claude/whatsinmycontext`:

```bash
npx -y whatsinmycontext init
```

The installer runs **once**; the status line then calls the local scripts directly
(no per-tick `npx`), so there's no network/version-check lag on every render.

| Command | What it does |
|---------|--------------|
| `init` | Install. If a `statusLine` already exists, it is **chained** (yours runs first, this tree renders below). |
| `init --force` | Install, **overwriting** any existing `statusLine` instead of chaining. |
| `upgrade` | Re-copy the latest scripts (`npx whatsinmycontext@latest upgrade`). |
| `uninstall` | Remove the entries (restoring a chained predecessor) and the install dir. |

### What it changes on disk

- Backs up `~/.claude/settings.json` → `settings.json.wimc.bak` before writing.
- Copies the compiled scripts to `~/.claude/whatsinmycontext/dist`.
- For chaining, records the previous command in
  `~/.claude/whatsinmycontext/prev-statusline.txt`.
- If `settings.json` is present but not valid JSON, the install **aborts** rather
  than clobbering it.

## How it works

Two scripts cooperate through a small file in your temp dir:

- **`subagentStatusLine`** dumps the live `tasks[]` to a file and hides the native
  agent-panel rows.
- **`statusLine`** reads its own stdin (master total + window size), parses the
  session transcript for the component breakdown, reads the subagent dump, and
  renders the whole tree. The transcript parse is cached to the temp dir, so it
  re-parses only when the session advances.

## Notes & limitations

- **Component sizes are estimates** (~4 chars/token); per-agent **totals are exact**
  (from usage). `Thinking` is a residual and reads as an upper bound.
- **Subagent rows vanish ~15 s** after their last status tick (i.e. once they finish).
- **Background shells** are dropped the moment they stop running — including those
  **killed from the UI** (the X button), which leave no trace in the transcript. A live
  shell keeps its `tasks/<id>.output` file open for writing, so the render checks (one
  batched, cached `lsof` per tick) whether any process still holds it for write; if not,
  the shell is dead and hidden. This stays correct for a quiet-but-live process (e.g. an
  idle dev server) and ignores mere readers like `tail -f`. Requires `lsof` on `PATH`
  (default on macOS/Linux); without it, shells are dropped only by the `/compact` fallback.
- Some subagents report **no token count**; those show `—` instead of a misleading `0`.
- Glyphs are width-1 ASCII (no box-drawing) so columns align in both Latin and CJK
  terminals.

## Development

```bash
npm install
npm test       # tsc build + node:test (parser, render, installer) against dist/
```

Tests run against sanitized JSONL fixtures in `test/fixtures/` that mirror the real
Claude Code transcript schema but contain no private data.

## Status

Early (`0.0.1`). The npx install flow is the intended distribution shape.

## License

MIT
