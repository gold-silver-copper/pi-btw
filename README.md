# 💬 pi-btw — Side Questions for the Pi Coding Agent

[![npm](https://img.shields.io/npm/v/@narumitw/pi-btw)](https://www.npmjs.com/package/@narumitw/pi-btw) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

`@narumitw/pi-btw` is a native [Pi coding agent](https://pi.dev) extension that adds `/btw`, a side-question command for quick clarifications that should not interrupt or pollute the main agent conversation.

Use it when you want to ask a temporary question, inspect context, or get a short explanation while keeping the primary coding task focused.

## ✨ Features

- Adds a `/btw` menu for starting or resuming an in-memory side thread, choosing context from the main session tree, or changing pi-btw settings.
- Starts a fresh side thread from any persisted main-session branch without switching the main branch.
- Keeps `/btw <question>` as a direct fast path that always starts a fresh side thread.
- Answers side questions in a dedicated, scrollable full-screen UI.
- Keeps mouse-drag copying stable while the main agent continues running in the background.
- Supports follow-up questions in the same ephemeral side thread.
- Resumes any non-empty side thread retained by the current Pi session, listed by its first question.
- Queues Pi-style `Steering` questions while an answer is running and processes them one at a time.
- Optionally brings the latest answer, a question-to-end suffix, an exact line range, or the entire side thread into the main editor.
- Uses the current session branch as context.
- Uses Pi's current model or an independent model selected in `pi-btw.json`.
- Uses a pi-btw thinking level that can either start from the main thread or use a fixed remembered value.
- Does not append the side question or answer to the main conversation.
- Works as an independently installable npm Pi extension package.

## 📦 Install

```bash
pi install npm:@narumitw/pi-btw
```

Try without installing permanently:

```bash
pi -e npm:@narumitw/pi-btw
```

Try this package locally from the repository root:

```bash
pi -e ./packages/pi-btw
```

## 🚀 Usage

Open the pi-btw menu or provide the first question immediately:

```text
/btw
/btw <your side question>
```

Examples:

```text
/btw
/btw what does this TypeScript error mean?
/btw summarize the current implementation before we continue
/btw is this API name idiomatic?
```

Running `/btw` alone opens a menu with **Start side thread** selected first.
**Start from main thread tree…** opens Pi's native session tree and uses the root-to-selected-entry path, including the selected entry, as the new side thread's context.
Selecting context does not navigate, fork, append to, or switch the main conversation, and it preserves the main editor draft.
The selector is a snapshot of entries persisted when it opens, while the resulting side thread keeps an immutable context snapshot even if the main conversation later changes.
Press `Escape` to return to the `/btw` menu or `Ctrl+C` to close the flow.
The native tree controls remain available: copying reports success or failure, and an explicit `Shift+L` label edit persists through Pi as the only main-session mutation available from this selector.
When the current Pi session has non-empty side threads in memory, **Resume side thread** opens a bounded searchable choice list.
Search matches the displayed first question and question count while returning the thread's raw in-memory ID.
**Settings** changes the starting thinking level and whether shortcut changes for fixed levels are remembered.
Each Resume row keeps the first question as its fixed title, shows its question count, and the list is ordered by the newest recorded answer or visible error.
Opening and closing a thread without a new result does not reorder it.
`/btw <question>` bypasses this menu and always starts a fresh side thread.
Its answer opens above the side-thread editor.
The side thread uses a dedicated full-screen terminal view.
The main agent continues running in the background, but its screen rendering stays suspended until
`/btw` closes, so new main-thread output cannot move a mouse selection inside the side thread.
Drag the primary mouse button across side-thread text to select and copy it through Pi's terminal
clipboard support. Returning from `/btw` redraws the main view with everything produced while it
was hidden. A compact `btw · side thread` header stays fixed above the content so the ephemeral
workspace remains recognizable while scrolling. Messages use Pi's normal
user and assistant presentation without numbered turns or role labels. Type each question and press
`Enter`; no follow-up shortcut is required.
Previous side questions and answers remain available to the model and visible for that
invocation. The side-thread header shows its current thinking level. Press Pi's configured
`app.thinking.cycle` shortcut (`Shift+Tab` by default) in the composer to cycle the levels
supported by the side-thread model; every later question uses the displayed level until it is
changed again. When a fixed thinking level is selected, each shortcut change is also written to
`pi-btw.json` for the next invocation by default. Turn **Remember thinking level changes** off in
Settings to keep fixed-level changes local to the current side thread. When **Same as main thread** is
selected, shortcut changes are always local to the current side thread. Neither path changes the main
session's thinking level.
While a response is running, the transcript and composer remain visible above an `Answering…`
status.
Type another question and press `Enter` to queue it as `Steering`; queued questions are shown in
submission order and answered one at a time after the active response completes.
A queued question uses the side thread's thinking level when its turn begins.
A failed active response is shown in the transcript and does not discard later steering questions.
Use the mouse wheel or trackpad to scroll transcript history like Pi's main thread.
Keyboard `PgUp`/`PgDn` history navigation remains available.
It appears in the footer only when the transcript can scroll.
Press `Ctrl+C` to cancel the active response and discard the ephemeral side-thread draft and steering queue.
Completed questions, answers, and visible errors remain available through Resume until the current extension instance ends.
Steering remains entirely inside pi-btw and never appends to the main conversation or editor.

After at least one successful answer, press `Ctrl+R` to bring selected context to the main
editor. The scope menu shows the size of the latest question and answer and the entire side
thread before you choose. Bring the latest question and answer, everything from a chosen
question onward, an exact text range, or the entire side thread. Question-suffix, exact-range,
and entire-thread choices preview the exact editable context block before the side thread closes;
`Escape` returns and `Ctrl+C` closes without bringing anything to main.

The text-range selector supports both fast line selection and editor-style character selection.
It reports whether anything is selected plus the selected line, message, and approximate token
counts. Press `Space` to select the current raw source line, then use `Up`/`Down` to extend by
whole lines; press `Space` again to clear it. Alternatively, use the arrow keys to move the cursor
and `Shift`+arrow keys to extend a character-level selection. Starting a Shift selection replaces
any active line selection. Selected lines include a visible `●` marker in addition to highlighting.
Pi's configured keys control vertical navigation, bringing, and going back (`Up`/`Down`, `Enter`,
and `Escape` by default), and the selector displays the active keys. Selection follows raw source
text rather than terminal-wrapped visual rows.

Bringing context to main closes the side thread and loads a deterministic, editable context block
into Pi's main editor. It never sends the draft automatically. If the main editor already has a
draft, append is the recommended default. Replace is labeled as destructive and requires a second
confirmation; Cancel returns to the side thread without changing either draft. Concurrent editor
updates made while these menus are open are preserved. A success message reports whether context
was loaded, appended, or replaced and its approximate size.
Without an explicit bring-to-main action, closing `/btw` never adds the side thread to the main
conversation. Non-empty threads remain only in memory for Resume within the current Pi session.
`/new`, Pi `/resume`, `/reload`, extension replacement, and process restart discard every retained
thread. Unsent drafts, steering queues, interrupted answers, and model credentials are never retained.

## ⚙️ Model and thinking level

By default, `/btw` uses the current session model. To use an independent model for side
questions, create:

```text
$PI_CODING_AGENT_DIR/pi-btw.json
```

The normal location is `~/.pi/agent/pi-btw.json`. `PI_CODING_AGENT_DIR` is an existing Pi
setting; pi-btw does not add any environment variables.

```json
{
  "model": "anthropic/claude-sonnet-4-5",
  "thinkingLevel": "low",
  "rememberThinkingLevelChanges": true
}
```

The `model` value uses `provider/model-id` format. Only the first `/` is the separator, so
model IDs may contain additional slashes, such as `openrouter/anthropic/claude-sonnet`.
The configured model must exist in Pi's model registry and have usable credentials. If it
cannot be found or authenticated, pi-btw warns and falls back to the current session model.
If neither model is available, `/btw` reports an error and stops. This selection affects only
`/btw`; it does not change the main session model.

Pi calls its reasoning setting the **thinking level**. In Settings, choose **Same as main thread**
to start each new side thread from the main thread's current thinking level. This is stored by
omitting `thinkingLevel` from `pi-btw.json`.

Set `thinkingLevel` only when you want a fixed pi-btw starting level. Accepted fixed values are
`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. The initial value and shortcut cycle
are clamped to the selected side model's capabilities using Pi's model rules. Resumed side threads
keep their own local thinking level instead of re-syncing with the main thread. Pi-btw does not read,
write, or change the main session's `defaultThinkingLevel`.

`rememberThinkingLevelChanges` controls only persistence for fixed thinking levels and defaults to
`true` when omitted. A side-thread shortcut always changes that side thread immediately. When a fixed
thinking level is selected and remembering is on, the concrete level is written for the next
invocation; when off, `pi-btw.json` stays unchanged. When **Same as main thread** is selected,
shortcut changes stay local even when remembering is on. If a shortcut write fails, the local change
remains active and pi-btw warns that it was not remembered. A failed Settings-screen save instead
restores the previous displayed value.

A missing settings file is a side-effect-free read: pi-btw creates it only after a Settings change
or a remembered shortcut change. Saves are ordered within the Pi process and published atomically
with a same-directory temporary file and rename. They preserve `model` and unknown fields; malformed
or invalid files block saves and remain unchanged. Settings must be valid UTF-8 and no larger than
64 KiB, so unexpectedly large or invalidly encoded files are rejected without being rewritten.
Separate Pi processes and external editors are outside this in-process ordering boundary. The file
is read for each `/btw` invocation, so edits apply without `/reload`.

## 🧠 Why use pi-btw?

Normal assistant messages become part of the main Pi conversation and can distract the coding agent from the task. `pi-btw` creates a lightweight side channel for context-aware questions, making it useful for pair programming, debugging, code review, and repository exploration.

## 🗂️ Package layout

```txt
packages/pi-btw/
├── src/
│   ├── index.ts
│   ├── btw.ts
│   ├── bring-to-main.ts
│   ├── main-tree-picker.ts
│   ├── menu.ts
│   ├── settings.ts
│   ├── side-thread.ts
│   ├── text.ts
│   └── transcript-pager.ts
├── README.md
├── LICENSE
├── tsconfig.json
└── package.json
```

The package exposes its Pi extension through `package.json`:

```json
{
  "pi": {
    "extensions": ["./src/index.ts"]
  }
}
```

## 🔎 Keywords

Pi extension, Pi coding agent, AI coding agent, side question command, agent chat workflow, TypeScript Pi package, npm Pi extension.

## 📄 License

MIT. See [`LICENSE`](./LICENSE).
