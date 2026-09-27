import assert from "node:assert/strict";
import fc from "fast-check";
import { test } from "vitest";
import type { MainAgentActivity } from "../../src/activity.js";
import { buildSideContext, CONTEXT_BUDGET, messageText, TOOL_ARGS_CHARS } from "../../src/context.js";

// FUZZ_RUNS scales every property; `npm run fuzz` raises it.
const RUNS = Number(process.env.FUZZ_RUNS ?? 200);
const TIMEOUT = Math.max(10_000, RUNS * 60);
const options = { numRuns: RUNS, ...(process.env.FUZZ_SEED ? { seed: Number(process.env.FUZZ_SEED) } : {}) };

/** Tool-call arguments are built from runs of this character; nothing else produces it. */
const MARK = "☃";
const noMark = (text: string) => text.replaceAll(MARK, "");
const HUGE = [0, 1, 199, 200, 201, 2_000, 20_000, 120_000];
const text = fc
  .oneof(
    fc.string(),
    fc.string({ unit: "grapheme" }),
    fc.string({ unit: "binary" }),
    {
      weight: 2,
      arbitrary: fc.constantFrom(...HUGE).map((size) => "line with error: x\n".repeat(Math.ceil(size / 19)).slice(0, size)),
    },
  )
  .map(noMark);
const markRun = fc.constantFrom(...HUGE).map((size) => MARK.repeat(size));
const toolName = fc.oneof(fc.constantFrom("bash", "read", "edit", "write", "grep", "find", "ls", "goal_progress"), text);
const ids = fc.constantFrom("a", "b", "c", "d", "goal-1", "goal-2");
const time = fc.oneof(
  fc.integer({ min: Date.parse("2026-01-01T00:00:00Z"), max: Date.parse("2027-01-01T00:00:00Z") }).map((at) => new Date(at).toISOString()),
  fc.anything(),
);
const args = fc.oneof(
  fc.record({ command: markRun }),
  fc.record({ path: markRun, content: markRun }),
  fc.record({ path: markRun, edits: fc.array(fc.record({ oldText: markRun, newText: markRun }), { maxLength: 3 }) }),
  fc.record({ pattern: markRun, path: markRun }),
  fc.dictionary(fc.string().map(noMark), fc.oneof(markRun, fc.array(markRun, { maxLength: 3 }), fc.record({ nested: markRun }))),
  markRun,
  fc.constant(undefined),
);
const block = fc.oneof(
  fc.record({ type: fc.constant("text"), text }),
  fc.record({ type: fc.constant("thinking"), thinking: text }),
  fc.record({ type: fc.constant("toolCall"), id: ids, name: toolName, arguments: args }),
  fc.constant(null),
  fc.anything().filter((value) => !JSON.stringify(value ?? null)?.includes(MARK)),
);
const content = fc.oneof(text, fc.array(block, { maxLength: 6 }), fc.constant(undefined));
const messageEntry = fc.record({
  type: fc.constant("message"),
  timestamp: time,
  message: fc.record({
    role: fc.constantFrom("user", "assistant", "toolResult", "system", "bashExecution", "custom"),
    content,
    toolCallId: ids,
    toolName,
    isError: fc.oneof(fc.boolean(), fc.anything()),
    timestamp: fc.oneof(fc.integer(), fc.anything()),
  }),
});
const goal = fc.oneof(
  fc.constant(null),
  fc.record(
    {
      id: ids,
      text,
      status: fc.oneof(fc.constantFrom("active", "paused", "blocked", "complete"), text),
      pauseReason: text,
      stopDetail: text,
      timeUsedSeconds: fc.oneof(fc.double(), fc.anything()),
      activeStartedAt: fc.oneof(fc.double(), fc.anything()),
      objectiveFile: fc.oneof(fc.record({ path: text }), fc.anything()),
      progress: fc.oneof(fc.array(fc.record({ at: fc.oneof(fc.double(), fc.anything()), note: text }), { maxLength: 8 }), fc.anything()),
      waiting: fc.oneof(fc.record({ reason: text, resumeAt: fc.double(), wakeWhen: fc.record({ command: text, pid: fc.integer() }) }), fc.anything()),
    },
    { requiredKeys: ["id"] },
  ),
  fc.anything().filter((value) => !JSON.stringify(value ?? null)?.includes(MARK)),
);
const entry = fc.oneof(
  { weight: 6, arbitrary: messageEntry },
  { weight: 2, arbitrary: fc.record({ type: fc.constant("custom"), customType: fc.constant("goal-state"), timestamp: time, data: fc.record({ goal }) }) },
  { weight: 1, arbitrary: fc.record({ type: fc.constant("compaction"), timestamp: time, summary: fc.oneof(text, fc.anything()) }) },
  { weight: 1, arbitrary: fc.anything().filter((value) => !JSON.stringify(value ?? null)?.includes(MARK)) },
);
/** A tool call and its result, as pi writes them. */
const pair = fc
  .record({ id: ids, name: toolName, args, output: text, isError: fc.boolean(), called: time, finished: time })
  .map(({ id, name, args, output, isError, called, finished }) => [
    { type: "message", timestamp: called, message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] } },
    { type: "message", timestamp: finished, message: { role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text: output }], isError } },
  ]);
const turn = fc.record({ question: text, answer: text, at: fc.double(), model: text, error: fc.option(fc.constant(true as const), { nil: undefined }) });
const activity = fc.record({
  running: fc.boolean(),
  runStartedAt: fc.option(fc.double(), { nil: undefined }),
  lastActivityAt: fc.option(fc.double(), { nil: undefined }),
  lastActivity: fc.option(text, { nil: undefined }),
  tools: fc.array(fc.tuple(ids, fc.record({ name: toolName, args, startedAt: fc.double() })), { maxLength: 3 }).map((pairs) => new Map(pairs)),
}) as fc.Arbitrary<MainAgentActivity>;
const input = fc.record({
  branch: fc.array(fc.oneof(entry.map((item) => [item]), pair), { maxLength: 80, size: "large" }).map((items) => items.flat()),
  question: text,
  turns: fc.array(turn, { maxLength: 35, size: "medium" }),
  activity: fc.option(activity, { nil: undefined }),
  idle: fc.option(fc.boolean(), { nil: undefined }),
  liveFacts: fc.option(text, { nil: undefined }),
  promptFile: fc.option(
    fc.oneof(
      fc.record({ kind: fc.constant("text" as const), text, sha256: fc.oneof(fc.constant("abc"), fc.string()) }),
      fc.record({ kind: fc.constant("unreadable" as const), reason: text }),
    ),
    { nil: undefined },
  ),
  now: fc.oneof(fc.integer({ min: Date.parse("2026-01-01T00:00:00Z"), max: Date.parse("2027-01-01T00:00:00Z") }), fc.double()),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An independent reading of what the objective should be. */
function expectedObjective(branch: readonly unknown[]): string | undefined {
  const texts = new Map<unknown, string>();
  let latest: Record<string, unknown> | undefined;
  for (const item of branch) {
    if (!isRecord(item) || item.type !== "custom" || item.customType !== "goal-state" || !isRecord(item.data)) continue;
    const goal = item.data.goal;
    if (!isRecord(goal)) continue;
    if (typeof goal.id === "string" && typeof goal.text === "string") texts.set(goal.id, goal.text);
    latest = goal;
  }
  if (latest) return typeof latest.text === "string" ? latest.text : texts.get(latest.id);
  const first = branch.find((item) => isRecord(item) && item.type === "message" && isRecord(item.message) && item.message.role === "user");
  return isRecord(first) && isRecord(first.message) ? messageText(first.message.content) : undefined;
}

test("the builder never throws, never exceeds its budget and keeps the objective", { timeout: TIMEOUT }, () => {
  fc.assert(
    fc.property(input, (value) => {
      const context = buildSideContext(value);
      assert.ok(context.length <= CONTEXT_BUDGET, `length ${context.length}`);
      assert.ok(context.startsWith("## Objective\n"));
      assert.ok(context.includes("## Main agent now\n"));
      assert.ok(context.endsWith("</side_question>"));
      const objective = expectedObjective(value.branch)?.trim();
      if (objective) assert.ok(context.includes(objective.slice(0, 60)), "objective kept");
      const longestRun = Math.max(0, ...[...context.matchAll(/☃+/gu)].map((match) => match[0].length));
      assert.ok(longestRun <= TOOL_ARGS_CHARS, `a tool call contributed ${longestRun} argument characters`);
    }),
    options,
  );
});

test("under pressure the budget holds and the newest activity is kept", { timeout: TIMEOUT }, () => {
  const heavy = fc.record({
    prose: fc.constantFrom(2_500, 30_000).map((size) => "P".repeat(size)),
    output: fc.constantFrom(900, 50_000).map((size) => "error: R\n".repeat(size / 9)),
    user: fc.constantFrom(1_600, 40_000).map((size) => "U".repeat(size)),
  });
  fc.assert(
    fc.property(fc.array(heavy, { minLength: 20, maxLength: 120 }), input, (items, value) => {
      const branch = items.flatMap((item, index) => [
        { type: "message", message: { role: "user", content: item.user } },
        { type: "message", message: { role: "assistant", content: [{ type: "text", text: item.prose }, { type: "toolCall", id: `h${index}`, name: "bash", arguments: { command: `step-${index}` } }] } },
        { type: "message", message: { role: "toolResult", toolCallId: `h${index}`, content: [{ type: "text", text: item.output }], isError: true } },
      ]);
      const context = buildSideContext({ ...value, branch: [...value.branch, ...branch] });
      assert.ok(context.length <= CONTEXT_BUDGET, `length ${context.length}`);
      assert.ok(context.includes(`bash \`step-${items.length - 1}\``), "the newest tool call is kept");
      assert.ok(context.includes("## Recent activity"));
    }),
    { ...options, numRuns: Math.max(20, Math.floor(RUNS / 5)) },
  );
});

test("the clock and new activity never change the sections before 'Main agent now'", { timeout: TIMEOUT }, () => {
  const smallTurn = fc.record({
    question: fc.string({ maxLength: 200 }),
    answer: fc.string({ maxLength: 300 }),
    at: fc.integer({ min: 0, max: 2_000_000_000_000 }),
    model: fc.constant("m"),
    error: fc.option(fc.constant(true as const), { nil: undefined }),
  });
  // Later activity: tool calls, their results and agent prose; no new goal state or compaction.
  const later = fc.array(
    fc.oneof(
      pair,
      fc.record({ role: fc.constantFrom("assistant", "toolResult"), content, at: time }).map(({ role, content, at }) => [
        { type: "message", timestamp: at, message: { role, content } },
      ]),
    ),
    { maxLength: 15 },
  );
  fc.assert(
    fc.property(
      input,
      fc.array(smallTurn, { maxLength: 10 }),
      later,
      fc.array(smallTurn, { maxLength: 3 }),
      fc.integer({ min: 0, max: 7 * 86_400_000 }),
      text,
      (value, turns, extra, newTurns, delta, question) => {
        const first = buildSideContext({ ...value, turns });
        const stable = first.slice(0, first.indexOf("\n\n## Main agent now"));
        const second = buildSideContext({
          ...value,
          branch: [...value.branch, ...extra.flat()],
          turns: [...turns, ...newTurns],
          now: value.now + delta,
          question,
        });
        assert.ok(second.startsWith(stable), "sections 1-3 are a stable prefix");
      },
    ),
    options,
  );
});
