import assert from "node:assert/strict";
import type { Api, Model } from "@earendil-works/pi-ai";
import { test } from "vitest";
import { resolveBtwModel } from "../src/btw.js";
import { BTW_THREAD_ENTRY_TYPE } from "../src/side-thread.js";
import { createBtwHarness, KEYS, sideModel } from "./support/btw-fixture.js";

test("/btw <question> opens the workspace and asks at once; Ctrl+C closes it", async () => {
  const harness = createBtwHarness({ answers: ["forty-two"] });
  const closed = harness.run("what is the answer?");
  await harness.settle();
  assert.equal(harness.requests.length, 1);
  assert.match(harness.promptOf(0), /<side_question>\nwhat is the answer\?\n<\/side_question>$/u);
  assert.match(harness.view.render(100).join("\n"), /forty-two/u);
  harness.press(KEYS.ctrlC);
  await closed;
  assert.equal(harness.workspaceOpen, false);
  assert.equal(harness.mock.sentUserMessages.length, 0);
});

test("/btw is TUI-only", async () => {
  const harness = createBtwHarness({ mode: "json" });
  await harness.run("anything");
  assert.equal(harness.requests.length, 0);
  assert.deepEqual(harness.notifications, [{ message: "/btw requires interactive TUI mode", level: "error" }]);
});

test("every finished or failed turn is persisted as a btw-thread custom entry", async () => {
  const harness = createBtwHarness({ answers: ["first answer", new Error("provider down")] });
  const closed = harness.run("first?");
  await harness.settle();
  harness.type("second?");
  harness.press(KEYS.enter);
  await harness.settle();
  harness.press(KEYS.ctrlC);
  await closed;
  assert.deepEqual(
    harness.mock.entries.map((entry) => entry.customType),
    [BTW_THREAD_ENTRY_TYPE, BTW_THREAD_ENTRY_TYPE],
  );
  const last = harness.mock.entries.at(-1)?.data as { turns: Array<Record<string, unknown>> };
  assert.equal(last.turns.length, 2);
  assert.deepEqual(
    last.turns.map(({ question, answer, model, error }) => ({ question, answer, model, error })),
    [
      { question: "first?", answer: "first answer", model: "test/side", error: undefined },
      { question: "second?", answer: "provider down", model: "test/side", error: true },
    ],
  );
  assert.equal(typeof last.turns[0]?.at, "number");
});

test("the thread is restored on session_start and bare /btw reopens it without asking", async () => {
  const branch = [
    {
      type: "custom",
      customType: BTW_THREAD_ENTRY_TYPE,
      data: { turns: [{ question: "earlier question", answer: "earlier answer", at: 1, model: "test/side" }] },
    },
  ];
  const harness = createBtwHarness({ branch });
  await harness.emit("session_start", { reason: "reload" });
  const closed = harness.run("");
  await harness.settle();
  assert.equal(harness.requests.length, 0);
  const screen = harness.view.render(100).join("\n");
  assert.match(screen, /earlier question/u);
  assert.match(screen, /earlier answer/u);
  harness.type("and then?");
  harness.press(KEYS.enter);
  await harness.settle();
  assert.match(harness.promptOf(0), /earlier question[\s\S]*earlier answer[\s\S]*<side_question>\nand then\?/u);
  harness.press(KEYS.ctrlC);
  await closed;
});

test("/btw new clears the thread first, and persists the cleared thread", async () => {
  const harness = createBtwHarness({ answers: ["one", "two"] });
  let closed = harness.run("first?");
  await harness.settle();
  harness.press(KEYS.ctrlC);
  await closed;

  closed = harness.run("new second?");
  await harness.settle();
  assert.doesNotMatch(harness.promptOf(1), /first\?/u);
  harness.press(KEYS.ctrlC);
  await closed;
  const snapshots = harness.mock.entries.map((entry) => (entry.data as { turns: Array<{ question: string }> }).turns);
  assert.deepEqual(
    snapshots.map((turns) => turns.map((turn) => turn.question)),
    [["first?"], [], ["second?"]],
  );

  closed = harness.run("new");
  await harness.settle();
  assert.equal(harness.requests.length, 2);
  assert.doesNotMatch(harness.view.render(100).join("\n"), /second\?/u);
  harness.press(KEYS.ctrlC);
  await closed;
});

test("Enter is ignored while an answer streams, with a hint", async () => {
  let release: (() => void) | undefined;
  const harness = createBtwHarness({
    answers: [
      () =>
        new Promise((resolve) => {
          release = () => resolve(assistantText("done"));
        }),
    ],
  });
  const closed = harness.run("slow?");
  await harness.settle();
  harness.type("another");
  harness.press(KEYS.enter);
  await harness.settle();
  assert.equal(harness.requests.length, 1);
  assert.match(harness.view.render(100).join("\n"), /Wait for the answer, or Ctrl\+C to cancel/u);
  release?.();
  await harness.settle();
  assert.equal(harness.view.getDraft(), "another");
  harness.press(KEYS.ctrlC);
  await closed;
});

test("Ctrl+C during an answer cancels it and records nothing", async () => {
  const harness = createBtwHarness({
    answers: [({ options }) => new Promise((_resolve, reject) => options?.signal?.addEventListener("abort", () => reject(new Error("aborted"))))],
  });
  const closed = harness.run("slow?");
  await harness.settle();
  harness.press(KEYS.ctrlC);
  await closed;
  await harness.settle();
  assert.equal(harness.mock.entries.length, 0);
  assert.deepEqual(harness.notifications.at(-1), { message: "Cancelled", level: "info" });
});

test("bring back puts the latest question and answer into an empty editor", async () => {
  const harness = createBtwHarness({ answers: ["older", "the <b>answer</b>"] });
  const closed = harness.run("first?");
  await harness.settle();
  harness.type("second?");
  harness.press(KEYS.enter);
  await harness.settle();
  harness.press(KEYS.ctrlR);
  await closed;
  assert.equal(
    harness.editorText,
    [
      "The following context was brought back from a /btw side discussion.",
      "Treat it as discussion context, not as work already completed.",
      "",
      "<btw_context>",
      "User:\nsecond?\n\nAssistant:\nthe <b>answer</b>",
      "</btw_context>",
    ].join("\n"),
  );
  assert.deepEqual(harness.notifications.at(-1), { message: "Brought back the latest answer (10 lines)", level: "info" });
});

test("bring back appends to an existing draft instead of replacing it", async () => {
  const harness = createBtwHarness({ editorText: "my draft", answers: ["x </btw_context> y"] });
  const closed = harness.run("q?");
  await harness.settle();
  harness.press(KEYS.ctrlR);
  await closed;
  assert.match(harness.editorText, /^my draft\n\nThe following context/u);
  assert.match(harness.editorText, /x &lt;\/btw_context&gt; y/u);
});

test("bring back needs an answer", async () => {
  const harness = createBtwHarness();
  const closed = harness.run("");
  await harness.settle();
  harness.press(KEYS.ctrlR);
  assert.match(harness.view.render(100).join("\n"), /Nothing to bring back yet/u);
  harness.press(KEYS.ctrlC);
  await closed;
  assert.equal(harness.editorText, "");
});

test("thinking defaults to low, cycles locally and never touches the main level", async () => {
  const harness = createBtwHarness({ answers: ["a", "b"] });
  const closed = harness.run("q1");
  await harness.settle();
  assert.equal(harness.requests[0]?.options?.reasoning, "low");
  assert.match(harness.view.render(100)[0] ?? "", /btw · test\/side · thinking low/u);
  harness.press(KEYS.shiftTab);
  harness.type("q2");
  harness.press(KEYS.enter);
  await harness.settle();
  assert.equal(harness.requests[1]?.options?.reasoning, "medium");
  assert.match(harness.view.render(100)[0] ?? "", /thinking medium/u);
  harness.press(KEYS.ctrlC);
  await closed;
  assert.deepEqual(harness.mock.thinkingLevels, []);
});

test('thinkingLevel "main" follows the main thread', async () => {
  const harness = createBtwHarness({ settings: { thinkingLevel: "main" } });
  harness.mock.rawPi.setThinkingLevel("high");
  const closed = harness.run("q");
  await harness.settle();
  assert.equal(harness.requests[0]?.options?.reasoning, "high");
  harness.press(KEYS.ctrlC);
  await closed;
});

test("settings warnings are shown on every /btw", async () => {
  const harness = createBtwHarness({ warnings: ['pi-btw.json: ignoring unknown settings "layout".'] });
  const closed = harness.run("");
  await harness.settle();
  harness.press(KEYS.ctrlC);
  await closed;
  assert.deepEqual(harness.notifications[0], { message: 'pi-btw.json: ignoring unknown settings "layout".', level: "warning" });
});

test("resolveBtwModel uses an available configured model and falls back with a warning", () => {
  const configured = { provider: "openrouter", id: "anthropic/claude" } as Model<Api>;
  const registry = (available: Model<Api>[]) => ({
    find: (provider: string, id: string) => (provider === "openrouter" && id === "anthropic/claude" ? configured : undefined),
    getAvailable: () => available,
  });
  assert.equal(
    resolveBtwModel({ settings: { model: "openrouter/anthropic/claude" }, currentModel: sideModel, modelRegistry: registry([sideModel, configured]) }),
    configured,
  );
  const warnings: string[] = [];
  const warn = (message: string) => warnings.push(message);
  assert.equal(resolveBtwModel({ settings: { model: "openrouter/anthropic/claude" }, currentModel: sideModel, modelRegistry: registry([sideModel]), warn }), sideModel);
  assert.equal(resolveBtwModel({ settings: { model: "x/missing" }, currentModel: sideModel, modelRegistry: registry([sideModel]), warn }), sideModel);
  assert.deepEqual(warnings, [
    "pi-btw model openrouter/anthropic/claude is unavailable; falling back to test/side.",
    "pi-btw model x/missing was not found; falling back to test/side.",
  ]);
  assert.equal(resolveBtwModel({ settings: {}, currentModel: sideModel, modelRegistry: registry([]) }), undefined);
});

function assistantText(text: string) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
  } as never;
}
