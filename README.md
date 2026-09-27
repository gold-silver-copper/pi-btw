# pi-btw

A pi extension for side questions about a running agent: `/btw how close are you to being done?` answers in a side thread and adds nothing to the main conversation unless you bring it back.

Forked from [`@narumitw/pi-btw`](https://github.com/narumiruna/pi-extensions/tree/main/packages/pi-btw) 0.61.1 (`github.com/narumiruna/pi-extensions`, `packages/pi-btw`, commit `9058c15011ed250e69b89dbd680d785a82deb87d`, MIT). See [What changed from upstream](#what-changed-from-upstream).

## Install

```bash
pi remove npm:@narumitw/pi-btw        # if installed: two /btw commands would clash
pi install git:github.com/gold-silver-copper/pi-btw
```

pi loads `src/index.ts` directly; there is no build step.

## Using it

| Command | What it does |
| --- | --- |
| `/btw <question>` | Open the side thread and ask. |
| `/btw` | Reopen the side thread with an empty composer. |
| `/btw new <question>`, `/btw new` | Clear the thread first. |

`/btw` works in the TUI only; other modes say so and do nothing. It opens a fullscreen workspace: the thread's questions and answers above a composer. The header shows the side model and thinking level.

Each question is a separate, tool-less model call with its own system prompt and its own routing session id. With `claude-bridge` it runs as a one-shot Claude Code process, which counts against the same usage limit as the main agent.

## Keys

| Key | Action |
| --- | --- |
| `Enter` | Send the question. Ignored while an answer is pending: wait, or cancel. |
| `Ctrl+R` | Bring back: close the side thread and add the latest question and answer to the main editor. |
| `Ctrl+N` | Steer the main agent (below). |
| pi's thinking-cycle key (`Shift+Tab` by default) | Raise or lower this thread's thinking level. |
| `Ctrl+C` | Cancel a pending answer and close the side thread. |
| `PgUp` / `PgDn`, mouse wheel, `End` | Scroll; jump back to the latest answer. |

Selecting text with the mouse copies it. The keys are fixed; `Ctrl+N` is used by neither pi's editor nor terminal flow control (`Ctrl+S`/`Ctrl+Q`).

**Bring back** adds this block to the main editor, after any draft you have (it never replaces one), and reports "Brought back the latest answer (N lines)". Nothing is sent.

```text
The following context was brought back from a /btw side discussion.
Treat it as discussion context, not as work already completed.

<btw_context>
User:
…
Assistant:
…
</btw_context>
```

**Steer** closes the side thread and opens pi's editor with the composer's draft, or the latest answer when the composer is empty. Confirm, and the text goes to the main agent: as a steer while it is running, as a normal message when it is idle. Cancel, and you are back in the side thread with the draft. pi-goal treats a message sent this way as extension input: it wakes a waiting goal, but it cannot resume a paused one (type "continue" yourself for that).

## What the side model sees

pi-btw builds the context again for every question, so a follow-up such as "and now?" sees the current state. The request is one user message with these sections, in this order, and the question last:

1. **Objective.** With pi-goal: the objective, its status and pause reason, the prompt file path, the active time and the last five progress notes with their ages. Without it: the first user message. Up to 4,000 characters.
2. **Earlier work.** The latest compaction summary, up to 8,000 characters.
3. **Earlier side questions.** This thread's questions and answers, oldest first, newest kept within 15,000 characters.
4. **Main agent now.** Running or idle, the tool running now and for how long (for example ``bash `cargo test --workspace` running for 23m``), the time since its last activity, and whether a goal is waiting and on what.
5. **Recent activity.** A timeline with wall-clock times, newest last: user messages, the agent's prose and the tail of its reasoning, and one line per tool call with its result paired to it (ok or error, the exit code for `bash`, the duration, and up to eight key lines such as test summaries and errors). Tool calls never include file contents: `write` shows the path and size, `edit` the path and the number of edits.
6. **Live repository facts** (below).

The whole request stays under 60,000 characters. Sections 1, 2, 4 and 6 have their own caps and are always kept; the timeline gets what remains.

The side model is told the sections were collected just now, to answer progress questions from the objective, the notes, the current tool and recent results and say what remains, to say when something can't be told from the context, and never to claim it ran anything.

### Live repository facts

When you send a question, pi-btw runs a few read-only commands (git 3 s, `gh` 6 s, all in parallel) and shows "collecting repository facts…" meanwhile. For the session's working directory and, when different, the repository the main agent most recently worked in (the newest `cd` target or absolute path in its tool calls; at most two repositories):

- `git status -sb` (first 20 lines) and `git log --oneline -5`
- whether a rebase, merge, cherry-pick or revert is in progress
- the current branch's pull request: `PR #2502 "…" open, checks: 14 passed, 1 failed (clippy), 2 pending`

Results are reused for 20 seconds within a thread. Anything that fails (not a git repository, no `gh`, no pull request) is skipped silently. These are not model tools: the side call stays tool-less.

## The session thread

Each session has one side thread. After every answered or failed question pi-btw appends the thread as a `btw-thread` custom entry: the newest 30 turns, each answer capped at 20,000 characters. Custom entries never reach the main model. The thread is restored when the session starts, so it survives `/reload` and restarts. `/btw new` clears it. The thinking level you pick in a thread lasts until `/btw new` or `/reload`.

## Settings

`~/.pi/agent/pi-btw.json` (or `$PI_CODING_AGENT_DIR/pi-btw.json`), read on every `/btw`. pi-btw never writes it. All keys are optional:

```json
{ "model": "provider/model-id", "thinkingLevel": "low", "liveFacts": true }
```

| Key | Default | Meaning |
| --- | --- | --- |
| `model` | the main session's model | The side model, as `provider/model-id` (only the first `/` separates). Falls back to the session's model, with a warning, when it is missing or has no credentials. |
| `thinkingLevel` | `"low"` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`, clamped to the model; `"main"` uses the main thread's level. |
| `liveFacts` | `true` | Collect live repository facts. |

Unknown keys (including upstream's `keybindings`, `layout`, `sidePaneRatio`, `fullscreenCopyOnSelect` and `rememberThinkingLevelChanges`) are ignored with one warning naming them. Invalid values fall back to their defaults with a warning.

pi-btw never changes the main session's model, thinking level, branch or editor draft, except that bring-back adds to the draft.

## Development

```bash
npm install
npm run typecheck
npm test                  # vitest, with the mock pi in test/support/
npm run fuzz              # fast-check, 2,000 runs per property (below)
BTW_AUDIT=1 npx vitest run test/audit.test.ts   # measure the builder on your newest 30 goal sessions
python3 test/fixtures/drive-tui.py /tmp/pi-btw-tui   # offline end-to-end run in the real pi TUI (needs pyte and a pi-goal checkout)
node test/fixtures/measure-bridge-cache.mjs system.txt question-1.txt question-2.txt   # live: cache use through claude-bridge
```

The fuzz properties (`test/fuzz/`):

- **Context builder:** any branch (random roles, content blocks, compaction and goal-state entries, huge or empty payloads) never throws, stays within 60,000 characters, keeps the objective, and never emits more than 200 characters of a tool call's arguments. Under pressure the newest activity is kept. The clock and new activity never change the sections before "Main agent now".
- **The command, as a state machine:** random sequences of `/btw`, typing, sending, answers that succeed, fail or throw, `Ctrl+C`, `Ctrl+R`, `Ctrl+N` (sent or cancelled), `/btw new`, `/reload`, idle changes, agent events and new entries, checked after every step against a model: the persisted thread, the main editor (it only ever gets appended to), what reaches the main agent (only confirmed steers, as a steer while it runs), one side request at a time, each tool-less and within budget with the question last, the thinking level sent, and the main thinking level untouched.
- **Workspace:** any keystrokes, pastes and escape sequences at widths of 10 to 200 columns keep every line within the width, never submit while an answer is pending, and close at most once.
- **Live facts:** only `git -C … rev-parse|status|log` and `gh pr view` ever run, whatever the commands print; directories taken from tool calls are existing absolute directories; any pull-request JSON is summarized or ignored; the 20-second cache collects again exactly when it should.
- **Parsers:** the settings reader and thread restore accept anything.

`test/fixtures/offline-provider.ts` is a scripted offline model for driving pi by hand; the audit test writes its report outside the repository and commits no session content.

### Prompt caching

Through claude-bridge a side question is one tool-less Claude Code turn whose whole request is a single prompt string, and Claude Code caches at the end of it. Measured with `measure-bridge-cache.mjs` on a real 60,000-character context (about 28,000 tokens):

| | Cache read | Cache write |
| --- | --- | --- |
| A question | 0 | 27,941 |
| The same request again | 27,941 | 0 |
| A follow-up two minutes later | 0 | 27,977 |

Only an identical request reuses the cache. A follow-up shares its first sections with the question before it, and would share the whole earlier request if it were built to, but the cache is only read at content-block boundaries and the bridge sends one block, so nothing is reused. Providers that cache by token prefix can reuse the first sections, which is why nothing in them depends on the clock.

## What changed from upstream

- **Context.** Upstream sent the last 40,000 characters of user and assistant messages, frozen when the thread opened, question first. That dropped every tool result, lost the objective at almost every point of a long goal, and was mostly raw tool-call JSON. The new builder is described above. Measured at 120 points of 30 goal sessions (25/50/75/100% of each):

  | | Upstream 0.61.1 | pi-btw |
  | --- | --- | --- |
  | Objective present | 14 of 120 | 120 of 120 |
  | Tool-call arguments, share of the context (median) | 96% | 24% |
  | Tool results shown (median per point) | 0 (32 dropped inside the window) | 76 |
  | Time span of recent activity (median / 10th percentile) | 15 / 4 minutes | 37 / 11 minutes |
  | Largest context | 40,000 characters | 59,996 characters |

- **New:** live repository facts, steering the main agent, one thread per session that survives `/reload`, and a default thinking level of `low`.
- **Removed:** the manager and settings menu, the resume picker and multiple threads, "Start from main thread tree…", the side-pane layouts and live main-thread pane, transcript search, Mermaid rendering, the bring-to-main scope chooser, question-suffix scope, exact-range selector and whole-thread option, keybinding overrides and the keybinding editor, queued follow-up questions, every settings write, and the `@narumitw/pi-tui-kit` dependency. Answers render as plain Markdown.
- pi loads `src/index.ts` directly; the generated `dist/` runtime and its builder are gone.
- `src/` went from 5,860 lines to about 1,700.

## Known limits

- Live facts cover git and `gh` only; the side model still can't open files or run commands.
- The timeline keeps what fits in the budget; on a busy goal that is roughly the last half hour.
- What the main agent is doing right now (the running tool, when the run started) is tracked from pi's events in memory, so right after `/reload` it is known only from the session.
- Side calls use the same provider and usage limits as the main agent.
- Through claude-bridge, each question writes its whole context to the prompt cache and follow-ups do not read it back (see [Prompt caching](#prompt-caching)); the bridge's side-call path also ignores the thinking level.
- pi-tui's editor recurses without end on a double-width character at one or two columns wide, in pi's own editor too.

## License

MIT. See [`LICENSE`](./LICENSE).
