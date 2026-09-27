import assert from "node:assert/strict";
import type { Api, Model } from "@earendil-works/pi-ai";
import { test } from "vitest";
import {
  BTW_THREAD_ENTRY_TYPE,
  type CompleteSimpleFunction,
  completeSideTurn,
  extractAssistantText,
  MAX_ANSWER_CHARS,
  MAX_THREAD_TURNS,
  restoreThreadTurns,
  SYSTEM_PROMPT,
  serializeThread,
} from "../src/side-thread.js";
import { assistant, sideModel } from "./support/btw-fixture.js";

function recorder(response = assistant("side answer")) {
  const calls: Array<{ model: unknown; context: Parameters<CompleteSimpleFunction>[1]; options: Parameters<CompleteSimpleFunction>[2] }> = [];
  const completeSimple: CompleteSimpleFunction = async (model, context, options) => {
    calls.push({ model, context, options });
    return response;
  };
  return { calls, completeSimple };
}

test("a side turn is one tool-less user message with its own system prompt and routing id", async () => {
  const { calls, completeSimple } = recorder();
  const result = await completeSideTurn({
    model: sideModel,
    prompt: "the whole request",
    thinkingLevel: "low",
    routingSessionId: "side-route",
    completeSimple,
    sessionId: "main-session",
  });
  assert.deepEqual(result, { kind: "answered", answer: "side answer" });
  const [call] = calls;
  assert.ok(call);
  assert.equal(call.context.systemPrompt, SYSTEM_PROMPT);
  assert.equal(call.context.tools, undefined);
  assert.equal(call.context.messages.length, 1);
  assert.equal(call.context.messages[0]?.role, "user");
  assert.equal(call.options?.sessionId, "side-route");
  assert.equal(call.options?.reasoning, "low");
});

test("thinking off sends no reasoning option", async () => {
  const { calls, completeSimple } = recorder();
  await completeSideTurn({ model: sideModel, prompt: "q", thinkingLevel: "off", routingSessionId: "r", completeSimple });
  assert.equal(calls[0]?.options?.reasoning, undefined);
});

test("errors, malformed responses and aborts are reported, not thrown", async () => {
  const failing: CompleteSimpleFunction = async () => {
    throw new Error("network down");
  };
  const base = { model: sideModel, prompt: "q", thinkingLevel: "low" as const, routingSessionId: "r" };
  assert.deepEqual(await completeSideTurn({ ...base, completeSimple: failing }), { kind: "error", message: "network down" });
  const malformed: CompleteSimpleFunction = async () => ({ role: "user" }) as never;
  assert.equal((await completeSideTurn({ ...base, completeSimple: malformed })).kind, "error");
  const errored = recorder(assistant("", { stopReason: "error", errorMessage: "quota" }));
  assert.deepEqual(await completeSideTurn({ ...base, completeSimple: errored.completeSimple }), { kind: "error", message: "quota" });
  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(await completeSideTurn({ ...base, signal: controller.signal, completeSimple: failing }), { kind: "aborted" });
});

test("OpenCode attribution uses the main session id only in headers", async () => {
  const opencode = { provider: "opencode-go", id: "m" } as unknown as Model<Api>;
  const { calls, completeSimple } = recorder();
  await completeSideTurn({ model: opencode, prompt: "q", thinkingLevel: "off", routingSessionId: "r", completeSimple, sessionId: "main" });
  assert.deepEqual(calls[0]?.options?.headers, { "x-opencode-session": "main", "x-opencode-client": "pi" });
  assert.equal(calls[0]?.options?.sessionId, "r");

  const registry = recorder();
  registry.completeSimple.appliesRequestHeaderTransforms = true;
  await completeSideTurn({ model: opencode, prompt: "q", thinkingLevel: "off", routingSessionId: "r", completeSimple: registry.completeSimple, sessionId: "main" });
  const options = registry.calls[0]?.options;
  assert.equal(options?.headers, undefined);
  assert.deepEqual(await options?.transformHeaders?.({ "x-opencode-client": "custom" }), {
    "x-opencode-session": "main",
    "x-opencode-client": "custom",
  });
});

test("assistant text extraction ignores malformed content blocks", () => {
  const response = assistant("kept");
  response.content.push(null as never, { type: "text", text: 3 } as never, { type: "thinking", thinking: "hidden" } as never);
  assert.equal(extractAssistantText(response), "kept");
});

test("the persisted snapshot keeps the newest 30 turns and caps each answer", () => {
  const turns = Array.from({ length: 35 }, (_, index) => ({
    question: `q${index}`,
    answer: index === 34 ? "x".repeat(MAX_ANSWER_CHARS + 50) : `a${index}`,
    at: index,
    model: "test/side",
  }));
  const snapshot = serializeThread(turns);
  assert.equal(snapshot.turns.length, MAX_THREAD_TURNS);
  assert.equal(snapshot.turns[0]?.question, "q5");
  assert.equal(snapshot.turns.at(-1)?.answer.length, MAX_ANSWER_CHARS);
});

test("restore reads the latest btw-thread entry on the branch and skips malformed turns", () => {
  const entry = (turns: unknown) => ({ type: "custom", customType: BTW_THREAD_ENTRY_TYPE, data: { turns } });
  const branch = [
    entry([{ question: "old", answer: "old", at: 1, model: "m" }]),
    { type: "custom_message", customType: BTW_THREAD_ENTRY_TYPE, content: "not ours" },
    entry([
      { question: "q", answer: "a", at: 2, model: "test/side" },
      { question: "failed", answer: "boom", at: 3, model: "test/side", error: true },
      { question: 7, answer: "bad" },
      null,
      { question: "no time", answer: "ok" },
    ]),
  ];
  assert.deepEqual(restoreThreadTurns(branch), [
    { question: "q", answer: "a", at: 2, model: "test/side" },
    { question: "failed", answer: "boom", at: 3, model: "test/side", error: true },
    { question: "no time", answer: "ok", at: 0, model: "" },
  ]);
  assert.deepEqual(restoreThreadTurns([]), []);
  assert.deepEqual(restoreThreadTurns([entry("nope")]), []);
});
