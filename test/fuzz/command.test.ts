import assert from "node:assert/strict";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import fc from "fast-check";
import { test } from "vitest";
import { appendToDraft, formatBtwBringToMain } from "../../src/bring-to-main.js";
import { CONTEXT_BUDGET } from "../../src/context.js";
import { BTW_THREAD_ENTRY_TYPE, type CompleteSimpleFunction, MAX_THREAD_TURNS } from "../../src/side-thread.js";
import { assistant, createBtwHarness, KEYS } from "../support/btw-fixture.js";

// Random sequences of /btw use, checked against a model of what should happen after
// every step. FUZZ_RUNS scales the run count.
const RUNS = Number(process.env.FUZZ_RUNS ?? 100);
const TIMEOUT = Math.max(20_000, RUNS * 400);
const options = { numRuns: RUNS, ...(process.env.FUZZ_SEED ? { seed: Number(process.env.FUZZ_SEED) } : {}) };

const LEVELS = ["off", "minimal", "low", "medium", "high"];
const words = fc.stringMatching(/^[a-z ?]{0,12}$/u);
const question = fc.stringMatching(/^[a-z][a-z ?]{0,11}$/u);

type Action =
  | { kind: "open"; args: string }
  | { kind: "type"; text: string }
  | { kind: "enter" }
  | { kind: "finish"; outcome: "ok" | "error" | "throw" }
  | { kind: "ctrlC" }
  | { kind: "ctrlR" }
  | { kind: "ctrlN"; steer: string | undefined }
  | { kind: "thinking" }
  | { kind: "reload" }
  | { kind: "idle"; idle: boolean }
  | { kind: "event"; name: "agent_start" | "agent_end" | "tool_execution_start" | "tool_execution_end" }
  | { kind: "entry"; text: string };

const action: fc.Arbitrary<Action> = fc.oneof(
  { weight: 3, arbitrary: fc.oneof(fc.constant(""), question, question, words.map((text) => `new ${text}`), fc.constant("new")).map((args) => ({ kind: "open" as const, args })) },
  { weight: 4, arbitrary: words.map((text) => ({ kind: "type" as const, text })) },
  { weight: 4, arbitrary: fc.constant({ kind: "enter" as const }) },
  { weight: 6, arbitrary: fc.constantFrom("ok", "ok", "ok", "error", "throw").map((outcome) => ({ kind: "finish" as const, outcome: outcome as "ok" | "error" | "throw" })) },
  { weight: 2, arbitrary: fc.constant({ kind: "ctrlC" as const }) },
  { weight: 2, arbitrary: fc.constant({ kind: "ctrlR" as const }) },
  { weight: 2, arbitrary: fc.option(words, { nil: undefined }).map((steer) => ({ kind: "ctrlN" as const, steer })) },
  { weight: 1, arbitrary: fc.constant({ kind: "thinking" as const }) },
  { weight: 1, arbitrary: fc.constant({ kind: "reload" as const }) },
  { weight: 1, arbitrary: fc.boolean().map((idle) => ({ kind: "idle" as const, idle })) },
  { weight: 1, arbitrary: fc.constantFrom("agent_start", "agent_end", "tool_execution_start", "tool_execution_end").map((name) => ({ kind: "event" as const, name: name as "agent_start" })) },
  { weight: 1, arbitrary: words.map((text) => ({ kind: "entry" as const, text })) },
);

interface Turn {
  question: string;
  answer: string;
  error?: true;
}

async function run(actions: Action[]) {
  let idle = true;
  let steerResult: string | undefined;
  const editorPrefills: Array<string | undefined> = [];
  const pending: Array<{ settle(message: AssistantMessage | Error): void }> = [];
  const completeSimple: CompleteSimpleFunction = (_model, context, streamOptions) =>
    new Promise((resolve, reject) => {
      harness.requests.push({ context, options: streamOptions });
      const entry = {
        settle: (message: AssistantMessage | Error) => {
          pending.splice(pending.indexOf(entry), 1);
          if (message instanceof Error) reject(message);
          else resolve(message);
        },
      };
      pending.push(entry);
      streamOptions?.signal?.addEventListener("abort", () => entry.settle(assistant("", { stopReason: "aborted" })));
    });
  const harness = createBtwHarness({
    isIdle: () => idle,
    editor: async (_title, prefill) => {
      editorPrefills.push(prefill);
      return steerResult;
    },
    dependencies: { createCompleteSimple: () => completeSimple },
  });

  // The model.
  let open = false;
  let command: Promise<void> | undefined;
  let draft = "";
  let turns: Turn[] = [];
  let persisted: Turn[] | undefined;
  let inflight: string | undefined;
  let level = "low";
  let editor = "";
  let answers = 0;
  const sent: Array<{ text: string; options: unknown }> = [];
  const expectedRequests: Array<{ question: string; level: string }> = [];

  const ask = (question: string) => {
    inflight = question;
    expectedRequests.push({ question, level });
  };
  const closeWorkspace = async () => {
    open = false;
    draft = "";
    await command;
  };

  for (const step of actions) {
    switch (step.kind) {
      case "open": {
        if (open) continue;
        let question = step.args.trim();
        if (/^new(?:\s|$)/u.test(question)) {
          question = question.slice(3).trim();
          if (turns.length > 0) persisted = [];
          turns = [];
          level = "low";
        }
        command = harness.run(step.args);
        open = true;
        draft = "";
        if (question) ask(question);
        break;
      }
      case "type":
        if (!open) continue;
        harness.type(step.text);
        draft += step.text;
        break;
      case "enter":
        if (!open) continue;
        harness.press(KEYS.enter);
        if (inflight !== undefined) break;
        // pi's editor clears itself on submit, even when the question is blank.
        if (draft.trim()) ask(draft.trim());
        draft = "";
        break;
      case "finish": {
        const request = pending[0];
        if (!request || inflight === undefined) continue;
        answers += 1;
        const answer = `answer ${answers}`;
        if (step.outcome === "ok") request.settle(assistant(answer));
        else if (step.outcome === "error") request.settle(assistant("", { stopReason: "error", errorMessage: `failure ${answers}` }));
        else request.settle(new Error(`thrown ${answers}`));
        turns.push(
          step.outcome === "ok"
            ? { question: inflight, answer }
            : { question: inflight, answer: step.outcome === "error" ? `failure ${answers}` : `thrown ${answers}`, error: true },
        );
        turns = turns.slice(-MAX_THREAD_TURNS);
        persisted = turns;
        inflight = undefined;
        break;
      }
      case "ctrlC":
        if (!open) continue;
        harness.press(KEYS.ctrlC);
        inflight = undefined;
        await closeWorkspace();
        break;
      case "ctrlR": {
        if (!open) continue;
        harness.press(KEYS.ctrlR);
        const latest = turns.filter((turn) => !turn.error).at(-1);
        if (inflight !== undefined || !latest) break;
        editor = appendToDraft(editor, formatBtwBringToMain(latest.question, latest.answer));
        await closeWorkspace();
        break;
      }
      case "ctrlN": {
        if (!open) continue;
        steerResult = step.steer;
        const typed = draft;
        harness.press(KEYS.ctrlN);
        if (inflight !== undefined) break;
        const latest = turns.filter((turn) => !turn.error).at(-1);
        await harness.settle();
        assert.equal(editorPrefills.at(-1), typed.trim() ? typed : (latest?.answer ?? ""));
        if (step.steer?.trim()) {
          sent.push({ text: step.steer, options: idle ? undefined : { deliverAs: "steer" } });
          await closeWorkspace();
        } else {
          draft = typed;
        }
        break;
      }
      case "thinking":
        if (!open) continue;
        harness.press(KEYS.shiftTab);
        level = LEVELS[(LEVELS.indexOf(level) + 1) % LEVELS.length] ?? level;
        break;
      case "reload":
        if (open) continue;
        await harness.emit("session_start", { reason: "reload" });
        turns = persisted ?? turns;
        level = "low";
        break;
      case "idle":
        idle = step.idle;
        break;
      case "event":
        await harness.emit(step.name, { toolCallId: "t1", toolName: "bash", args: { command: "sleep 60" }, isError: false, messages: [] });
        break;
      case "entry":
        harness.branch.push({ type: "message", timestamp: new Date().toISOString(), message: { role: "user", content: step.text } });
        break;
    }
    await harness.settle();

    // Invariants.
    assert.equal(harness.workspaceOpen, open, `workspace open after ${step.kind}`);
    assert.ok(pending.length <= 1, "at most one side request in flight");
    assert.equal(harness.requests.length, expectedRequests.length, `requests after ${step.kind}`);
    harness.requests.forEach((request, index) => {
      const prompt = harness.promptOf(index);
      assert.ok(prompt.length <= CONTEXT_BUDGET);
      assert.ok(prompt.endsWith(`<side_question>\n${expectedRequests[index]?.question}\n</side_question>`));
      assert.equal(request.context.tools, undefined);
      assert.equal(request.options?.reasoning, expectedRequests[index]?.level === "off" ? undefined : expectedRequests[index]?.level);
    });
    const snapshots = harness.mock.entries.filter((entry) => entry.customType === BTW_THREAD_ENTRY_TYPE);
    const last = snapshots.at(-1)?.data as { turns: Turn[] } | undefined;
    assert.deepEqual(
      last?.turns.map(({ question, answer, error }) => ({ question, answer, ...(error ? { error } : {}) })),
      persisted,
      "the persisted thread",
    );
    assert.equal(harness.editorText, editor, "the main editor changes only by bring-back, which appends");
    assert.deepEqual(harness.mock.sentUserMessages, sent, "only confirmed steers reach the main agent");
    assert.deepEqual(harness.mock.sentMessages, []);
    assert.deepEqual(harness.mock.thinkingLevels, [], "the main thinking level never changes");
    if (open && inflight === undefined) assert.equal(harness.view.getDraft(), draft);
  }
  if (open) {
    harness.press(KEYS.ctrlC);
    await command;
  }
}

test("random /btw sessions keep the thread, the editor and the main agent consistent", { timeout: TIMEOUT }, async () => {
  await fc.assert(fc.asyncProperty(fc.array(action, { minLength: 5, maxLength: 60, size: "large" }), run), options);
});
