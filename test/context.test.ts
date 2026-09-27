import assert from "node:assert/strict";
import { test } from "vitest";
import type { MainAgentActivity } from "../src/activity.js";
import { buildSideContext, CONTEXT_BUDGET, formatToolCall } from "../src/context.js";
import { createBtwHarness, KEYS } from "./support/btw-fixture.js";
import {
  assistantEntry,
  compactionEntry,
  goalContractEntry,
  goalStateEntry,
  minutes,
  text,
  thinking,
  toolCall,
  toolResultEntry,
  userEntry,
} from "./support/session-entries.js";

const CARGO_OUTPUT = [
  "   Compiling rig-core v0.20.0",
  ...Array.from({ length: 40 }, (_, index) => `test providers::case_${index} ... ok`),
  "test providers::cassette_7 ... FAILED",
  "thread 'providers::cassette_7' panicked at src/lib.rs:12:5:",
  "failures:",
  "test result: FAILED. 140 passed; 2 failed; 0 ignored; 0 measured; 0 filtered out; finished in 3.21s",
  "error: test failed, to rerun pass `--lib`",
  "",
  "",
  "Command exited with code 101",
].join("\n");

function goal(overrides: Record<string, unknown> = {}) {
  return {
    id: "goal-1",
    text: "execute prompt.md",
    objectiveFile: { path: "/work/prompt.md", sha256: "abc" },
    status: "active",
    startedAt: minutes(0),
    updatedAt: minutes(30),
    iteration: 3,
    timeUsedSeconds: 1_800,
    toolFreeRuns: 0,
    ...overrides,
  };
}

test("tool results are paired with their calls, with the exit code, duration and key lines", () => {
  const context = buildSideContext({
    branch: [
      userEntry("run the tests", minutes(0)),
      assistantEntry([toolCall("c1", "bash", { command: "cargo test --workspace" })], minutes(1)),
      toolResultEntry("c1", "bash", CARGO_OUTPUT, minutes(4) + 13_000, true),
      assistantEntry([toolCall("c2", "bash", { command: "ls" })], minutes(5)),
      toolResultEntry("c2", "bash", "a\nb\nc\nd\ne\nf\ng", minutes(5) + 1_000),
    ],
    question: "did the tests pass?",
    now: minutes(6),
  });
  assert.match(
    context,
    /\[12:01:00\] bash `cargo test --workspace`\n {2}→ error, exit 101, 3m\n {2}\| test providers::cassette_7 \.\.\. FAILED\n {2}\| thread 'providers::cassette_7' panicked at src\/lib\.rs:12:5:\n {2}\| failures:\n {2}\| test result: FAILED\. 140 passed; 2 failed;[^\n]*\n {2}\| error: test failed, to rerun pass `--lib`\n/u,
  );
  assert.doesNotMatch(context, /case_3 \.\.\. ok/u);
  // Without key lines, the last five lines.
  assert.match(context, /\[12:05:00\] bash `ls`\n {2}→ ok, exit 0, 1s\n {2}\| c\n {2}\| d\n {2}\| e\n {2}\| f\n {2}\| g/u);
});

test("tool calls never include file contents", () => {
  const secret = "SECRET-FILE-BODY";
  const context = buildSideContext({
    branch: [
      assistantEntry(
        [
          toolCall("w", "write", { path: "/repo/src/lib.rs", content: `${secret}\n`.repeat(300) }),
          toolCall("e", "edit", { path: "/repo/src/main.rs", edits: [{ oldText: secret, newText: secret }, { oldText: "a", newText: "b" }] }),
          toolCall("r", "read", { path: "/repo/Cargo.toml" }),
          toolCall("x", "custom_tool", { payload: secret.repeat(100) }),
        ],
        minutes(1),
      ),
      toolResultEntry("w", "write", "Successfully wrote 5100 bytes to /repo/src/lib.rs", minutes(1)),
      toolResultEntry("e", "edit", "Successfully replaced 2 block(s) in /repo/src/main.rs.", minutes(1)),
      toolResultEntry("r", "read", `[package]\nname = "${secret}"\nerror = true`, minutes(1)),
    ],
    question: "q",
    now: minutes(2),
  });
  assert.match(context, /write \/repo\/src\/lib\.rs \(5100 chars\)/u);
  assert.match(context, /edit \/repo\/src\/main\.rs \(2 edits\)/u);
  assert.match(context, /read \/repo\/Cargo\.toml\n {2}→ ok, 0s, 3 lines/u);
  const custom = context.split("\n").find((line) => line.includes("custom_tool")) ?? "";
  assert.ok(custom.length < 240, custom);
  const outsideCustom = context.split("\n").filter((line) => !line.includes("custom_tool"));
  assert.equal(outsideCustom.join("\n").includes(secret), false);
});

test("each tool gets its one-line summary", () => {
  assert.equal(formatToolCall("bash", { command: "cd /repo &&\n  cargo build" }), "bash `cd /repo && ⏎ cargo build`");
  assert.equal(formatToolCall("grep", { pattern: "TODO", path: "src" }), "grep TODO in src");
  assert.equal(formatToolCall("find", { pattern: "*.rs" }), "find *.rs");
  assert.equal(formatToolCall("ls", {}), "ls .");
  assert.equal(formatToolCall("edit", { path: "a.ts", oldText: "x", newText: "y" }), "edit a.ts (1 edit)");
  assert.equal(formatToolCall("goal_progress", { note: "halfway" }), 'goal_progress {"note":"halfway"}');
  assert.equal(formatToolCall("bash", { command: "x".repeat(500) }).length, "bash ``".length + 200);
});

test("the objective, status, prompt file and last five progress notes come from pi-goal; active time is in the live section", () => {
  const long = `Build the widget. ${"Requirement. ".repeat(40)}`;
  const branch = [
    userEntry("Goal mode is active. <goal_objective>execute prompt.md</goal_objective>", minutes(0)),
    goalStateEntry(goal({ text: long }), minutes(0)),
    // pi-goal writes a long objective once per goal id.
    goalStateEntry(
      goal({
        text: undefined,
        timeUsedSeconds: 1_800,
        activeStartedAt: minutes(40),
        progress: Array.from({ length: 7 }, (_, index) => ({ at: minutes(index * 5), note: `note ${index}` })),
      }),
      minutes(40),
    ),
  ];
  const context = buildSideContext({ branch, question: "how close are we?", now: minutes(50) });
  const objective = context.slice(0, context.indexOf("## Main agent now"));
  assert.match(objective, /^## Objective\npi-goal status: active\nPrompt file: \/work\/prompt\.md/u);
  assert.ok(objective.includes(long.trim()));
  assert.doesNotMatch(objective, /note [01]\b/u);
  assert.match(objective, /- 12:10:00: note 2\n[\s\S]*- 12:30:00: note 6/u);
  // The clock-dependent parts live in "Main agent now", so the objective is a stable prefix.
  assert.match(context, /## Main agent now\n[\s\S]*Goal active time: 40m; latest progress note 20m ago/u);
  assert.equal(buildSideContext({ branch, question: "later?", now: minutes(90) }).slice(0, objective.length), objective);
});

test("a paused goal shows why", () => {
  const context = buildSideContext({
    branch: [goalStateEntry(goal({ status: "paused", pauseReason: "interrupted" }), minutes(1))],
    question: "q",
    now: minutes(2),
  });
  assert.match(context, /pi-goal status: paused · paused \(interrupted\)\n/u);
  assert.match(context, /Goal active time: 30m\n/u);
});

test("without pi-goal the objective is the first user message", () => {
  const context = buildSideContext({
    branch: [userEntry("Port the parser to Rust.", minutes(0)), userEntry("later message", minutes(5))],
    question: "q",
    now: minutes(6),
  });
  assert.match(context, /^## Objective\nFirst user message \(no pi-goal goal on this branch\):\nPort the parser to Rust\.\n/u);
});

test("the latest compaction summary appears as earlier work", () => {
  const context = buildSideContext({
    branch: [compactionEntry("old summary", minutes(10)), compactionEntry("## Done\n- parser ported", minutes(20))],
    question: "q",
    now: minutes(21),
  });
  assert.match(context, /## Earlier work\nCompaction summary from 12:20:00:\n## Done\n- parser ported/u);
  assert.doesNotMatch(context, /old summary/u);
});

test("the main agent's state: running tool and duration, last activity and a waiting goal", () => {
  const activity: MainAgentActivity = {
    running: true,
    runStartedAt: minutes(0),
    lastActivityAt: minutes(7),
    lastActivity: "bash started",
    tools: new Map([["t1", { name: "bash", args: { command: "cargo test --workspace" }, startedAt: minutes(7) }]]),
  };
  const branch = [
    goalStateEntry(goal({ waiting: { reason: "CI on PR 2502", wakeWhen: { command: "gh pr checks 2502" } } }), minutes(1)),
    assistantEntry([toolCall("t1", "bash", { command: "cargo test --workspace" })], minutes(7)),
  ];
  const context = buildSideContext({ branch, question: "why so slow?", activity, idle: false, now: minutes(30) });
  assert.match(context, /Status: running since 12:00:00 \(30m\)/u);
  assert.match(context, /Running now: bash `cargo test --workspace` running for 23m/u);
  assert.match(context, /Last activity: bash started 23m ago/u);
  assert.match(context, /Goal waiting: CI on PR 2502 \(wakes when `gh pr checks 2502` succeeds\)/u);
  assert.match(context, /\[12:07:00\] bash `cargo test --workspace`\n {2}→ still running/u);
  assert.match(buildSideContext({ branch: [], question: "q", activity, idle: true, now: minutes(30) }), /Status: idle/u);
});

test("sections come in order with the question last", () => {
  const context = buildSideContext({
    branch: [goalStateEntry(goal(), minutes(0)), compactionEntry("summary", minutes(1)), userEntry("hi", minutes(2))],
    question: "the question",
    turns: [{ question: "earlier q", answer: "earlier a", at: minutes(3), model: "m" }],
    liveFacts: "repo facts",
    now: minutes(4),
  });
  const headings = [...context.matchAll(/^## (.+)$/gmu)].map((match) => match[1]);
  assert.deepEqual(headings, [
    "Objective",
    "Earlier work",
    "Earlier side questions",
    "Main agent now",
    "Recent activity (newest last)",
    "Live repository facts",
  ]);
  assert.ok(context.endsWith("<side_question>\nthe question\n</side_question>"));
  assert.match(context, /## Earlier side questions\n\[12:03:00\] Q: earlier q\nA: earlier a/u);
});

test("the budget holds and the fixed sections survive a huge branch", () => {
  const branch: unknown[] = [goalStateEntry(goal({ text: "O".repeat(10_000) }), minutes(0)), compactionEntry("S".repeat(50_000), minutes(1))];
  for (let index = 0; index < 400; index += 1) {
    branch.push(
      userEntry("U".repeat(5_000), minutes(2 + index)),
      assistantEntry([text("P".repeat(9_000)), thinking("T".repeat(9_000)), toolCall(`c${index}`, "bash", { command: "C".repeat(9_000) })], minutes(2 + index)),
      toolResultEntry(`c${index}`, "bash", "error: R\n".repeat(2_000), minutes(2 + index)),
    );
  }
  const turns = Array.from({ length: 30 }, (_, index) => ({ question: `q${index}`, answer: "A".repeat(20_000), at: minutes(index), model: "m" }));
  const context = buildSideContext({ branch, question: "Q".repeat(20_000), turns, liveFacts: "F".repeat(20_000), now: minutes(500) });
  assert.ok(context.length <= CONTEXT_BUDGET, String(context.length));
  for (const heading of ["## Objective", "## Earlier work", "## Earlier side questions", "## Main agent now", "## Recent activity", "## Live repository facts"]) {
    assert.ok(context.includes(heading), heading);
  }
  assert.match(context, /\[\d+ earlier items omitted\]/u);
  assert.ok(context.includes("[12:29:00] Q: q29"), "keeps the newest side question");
  assert.ok(context.trimEnd().endsWith("</side_question>"));
});

test("pi-goal's contract messages stay out of the timeline", () => {
  const context = buildSideContext({ branch: [goalContractEntry("Goal-mode rules: ...", minutes(1))], question: "q", now: minutes(2) });
  assert.doesNotMatch(context, /Goal-mode rules/u);
});

test("the context is rebuilt for every question", async () => {
  const harness = createBtwHarness();
  harness.branch.push(userEntry("first request", minutes(0)));
  const closed = harness.run("status?");
  await harness.settle();
  harness.branch.push(assistantEntry([toolCall("n1", "bash", { command: "cargo build --release" })], Date.now()));
  harness.type("and now?");
  harness.press(KEYS.enter);
  await harness.settle();
  assert.doesNotMatch(harness.promptOf(0), /cargo build --release/u);
  assert.match(harness.promptOf(1), /cargo build --release/u);
  assert.match(harness.promptOf(1), /## Earlier side questions\n\[[\d:]+\] Q: status\?\nA: answer 1/u);
  harness.press(KEYS.ctrlC);
  await closed;
});

test("pi's tool events show up as the running tool", async () => {
  const harness = createBtwHarness({ isIdle: () => false });
  await harness.emit("agent_start");
  await harness.emit("tool_execution_start", { toolCallId: "t9", toolName: "bash", args: { command: "sleep 60" } });
  const closed = harness.run("what are you doing?");
  await harness.settle();
  assert.match(harness.promptOf(0), /Status: running since [\d:]+ \(0s\)\nRunning now: bash `sleep 60` running for 0s/u);
  harness.press(KEYS.ctrlC);
  await closed;
  await harness.emit("tool_execution_end", { toolCallId: "t9", toolName: "bash", isError: false });
  await harness.emit("agent_end", { messages: [] });
});

test("the goal's prompt file comes after the objective's usual lines, as read", () => {
  const promptFile = { kind: "text" as const, text: "# Parser\n\n1. Port the parser.\n2. Push.", sha256: "abc" };
  const branch = [goalStateEntry(goal({ progress: [{ at: minutes(5), note: "ported" }] }), minutes(5))];
  const context = buildSideContext({ branch, question: "q", promptFile, now: minutes(6) });
  assert.match(
    context,
    /^## Objective\npi-goal status: active\nPrompt file: \/work\/prompt\.md\nObjective:\nexecute prompt\.md\nProgress notes, newest last:\n- 12:05:00: ported\n\nPrompt file contents, read when this question was asked:\n<prompt_file>\n# Parser\n\n1\. Port the parser\.\n2\. Push\.\n<\/prompt_file>\n\n## Main agent now/u,
  );
  const changed = buildSideContext({ branch, question: "q", promptFile: { ...promptFile, sha256: "different" }, now: minutes(6) });
  assert.match(changed, /Prompt file contents, read when this question was asked; the file changed since the goal started:\n<prompt_file>/u);
});

test("a long prompt file keeps its head and tail within 12,000 characters", () => {
  const text = `HEAD-MARK\n${"middle line\n".repeat(3_000)}TAIL-MARK`;
  const context = buildSideContext({ branch: [goalStateEntry(goal(), minutes(0))], question: "q", promptFile: { kind: "text", text, sha256: "abc" } });
  const block = /<prompt_file>\n([\s\S]*)\n<\/prompt_file>/u.exec(context)?.[1] ?? "";
  assert.equal(block.length, 12_000);
  assert.ok(block.startsWith("HEAD-MARK") && block.endsWith("TAIL-MARK"));
  assert.match(block, /chars cut/u);
  assert.ok(context.indexOf("## Main agent now") < 16_100);
});

test("an unreadable prompt file is one line, and without a goal file nothing changes", () => {
  const branch = [goalStateEntry(goal(), minutes(0))];
  const missing = buildSideContext({ branch, question: "q", promptFile: { kind: "unreadable", reason: "the prompt file no longer exists" } });
  assert.match(missing, /\nPrompt file: \/work\/prompt\.md: the prompt file no longer exists\n/u);
  assert.doesNotMatch(missing, /<prompt_file>/u);
  const noFile = [goalStateEntry(goal({ objectiveFile: undefined }), minutes(0))];
  const plain = buildSideContext({ branch: noFile, question: "q", now: minutes(1) });
  assert.equal(buildSideContext({ branch: noFile, question: "q", promptFile: { kind: "text", text: "ignored", sha256: "x" }, now: minutes(1) }), plain);
  assert.doesNotMatch(plain, /Prompt file/u);
});

test("the objective section stays within 16,000 characters with a long objective, notes and file", () => {
  const branch = [
    goalStateEntry(goal({ text: "O".repeat(4_000), progress: Array.from({ length: 5 }, (_, index) => ({ at: minutes(index), note: "N".repeat(300) })) }), minutes(5)),
  ];
  const context = buildSideContext({ branch, question: "q", promptFile: { kind: "text", text: "F".repeat(50_000), sha256: "abc" }, now: minutes(6) });
  const objective = context.slice(0, context.indexOf("\n\n## Main agent now"));
  assert.ok(objective.length <= 16_000, String(objective.length));
  assert.ok(objective.includes("O".repeat(1_500)) && objective.includes("N".repeat(300)) && objective.includes("F".repeat(7_000)));
  assert.ok(context.length <= CONTEXT_BUDGET);
});
