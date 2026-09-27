import assert from "node:assert/strict";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import fc from "fast-check";
import { test } from "vitest";
import { createBtwShortcuts } from "../../src/keybindings.js";
import type { BtwTurn } from "../../src/side-thread.js";
import { BtwWorkspaceView } from "../../src/workspace.js";
import { KEYS, plainTheme, testKeybindings } from "../support/btw-fixture.js";

// FUZZ_RUNS scales every property; `npm run fuzz` raises it.
const RUNS = Number(process.env.FUZZ_RUNS ?? 200);
const TIMEOUT = Math.max(10_000, RUNS * 60);
const options = { numRuns: RUNS, ...(process.env.FUZZ_SEED ? { seed: Number(process.env.FUZZ_SEED) } : {}) };

const key = fc.oneof(
  fc.string({ maxLength: 3 }),
  fc.string({ unit: "binary", maxLength: 3 }),
  fc.integer({ min: 0, max: 31 }).map((code) => String.fromCharCode(code)),
  fc.constantFrom(
    KEYS.enter,
    KEYS.ctrlC,
    KEYS.ctrlR,
    KEYS.ctrlN,
    KEYS.shiftTab,
    "\u001b[A",
    "\u001b[B",
    "\u001b[5~",
    "\u001b[6~",
    "\u001b[200~",
    "\u001b[201~",
    "\u001b[200~pasted \u0003 \u0012\u001b[201~",
    "\u001b[99;5u",
    "\u001b[114;5u",
    "\u001b[110;5u",
    "\u001b",
    "\u007f",
  ),
);
type Step = { kind: "key"; data: string } | { kind: "start" } | { kind: "finish" } | { kind: "turn"; answer: string; error: boolean };
const step: fc.Arbitrary<Step> = fc.oneof(
  { weight: 8, arbitrary: key.map((data) => ({ kind: "key" as const, data })) },
  { weight: 1, arbitrary: fc.constant({ kind: "start" as const }) },
  { weight: 1, arbitrary: fc.constant({ kind: "finish" as const }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("turn" as const), answer: fc.string({ maxLength: 400 }), error: fc.boolean() }) },
);

test("any keystrokes keep the workspace within its width and its actions consistent", { timeout: TIMEOUT }, () => {
  initTheme("dark");
  fc.assert(
    // pi-tui's Editor recurses without end on a double-width character at 1-2 columns, in pi too.
    fc.property(fc.array(step, { maxLength: 60 }), fc.integer({ min: 10, max: 200 }), (steps, width) => {
      const turns: BtwTurn[] = [];
      const actions: string[] = [];
      let answering = false;
      const view = new BtwWorkspaceView({ terminal: { rows: 30, columns: width }, requestRender() {} } as never, plainTheme as never, {
        turns,
        model: "test/side",
        thinkingLevel: "low",
        thinkingLevels: ["off", "low", "high"],
        shortcuts: createBtwShortcuts(testKeybindings as never),
        handlers: {
          submit: (question) => {
            assert.ok(!answering, "no question while an answer is pending");
            assert.equal(question, question.trim());
            assert.ok(question.length > 0);
            actions.push("submit");
          },
          bringBack: () => {
            assert.ok(!answering && turns.some((turn) => !turn.error), "bring back needs a finished answer");
            actions.push("close");
          },
          steer: () => {
            assert.ok(!answering);
            actions.push("close");
          },
          cycleThinking: () => actions.push("thinking"),
          exit: () => actions.push("close"),
        },
      });
      view.focused = true;
      for (const item of steps) {
        const closed = actions.includes("close");
        const before = actions.length;
        if (item.kind === "key") view.handleInput(item.data);
        else if (item.kind === "start") {
          view.startAnswer("pending question", "collecting repository facts…");
          answering = true;
        } else if (item.kind === "finish") {
          view.finishAnswer();
          answering = false;
        } else {
          turns.push({ question: "q", answer: item.answer, at: 0, model: "m", ...(item.error ? { error: true as const } : {}) });
          view.refresh();
        }
        if (closed) assert.equal(actions.length, before, "nothing happens after the workspace closed");
        for (const line of view.render(width)) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}: ${JSON.stringify(line)}`);
      }
      assert.ok(actions.filter((action) => action === "close").length <= 1);
      view.dispose();
    }),
    options,
  );
});
