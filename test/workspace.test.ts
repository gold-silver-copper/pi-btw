import assert from "node:assert/strict";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { type Component, KeybindingsManager, type TUI, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { type BtwScreen, createBtwScreen, runBtwFullscreen } from "../src/fullscreen-ui.js";
import { createBtwShortcuts } from "../src/keybindings.js";
import type { BtwTurn } from "../src/side-thread.js";
import { BtwWorkspaceView, type BtwWorkspaceHandlers } from "../src/workspace.js";
import { KEYS, plainTheme, testKeybindings } from "./support/btw-fixture.js";

function createView(turns: BtwTurn[] = [], handlers: Partial<BtwWorkspaceHandlers> = {}) {
  initTheme("dark");
  const actions: string[] = [];
  const view = new BtwWorkspaceView({ terminal: { rows: 30, columns: 100 }, requestRender() {} } as never, plainTheme as never, {
    turns,
    model: "test/side",
    thinkingLevel: "low",
    thinkingLevels: ["off", "low", "high"],
    shortcuts: createBtwShortcuts(testKeybindings as never),
    handlers: {
      submit: (question) => actions.push(`submit:${question}`),
      bringBack: () => actions.push("bringBack"),
      cycleThinking: (level) => actions.push(`thinking:${level}`),
      exit: () => actions.push("exit"),
      ...handlers,
    },
  });
  view.focused = true;
  return { view, actions };
}

const answered: BtwTurn[] = [{ question: "Q1", answer: "A1", at: 1, model: "test/side" }];

test("the header shows the model and thinking level; the footer lists the keys", () => {
  const { view } = createView(answered);
  const lines = view.render(100);
  assert.match(lines[0] ?? "", /^─ btw · test\/side · thinking low ─+$/u);
  assert.ok(lines.some((line) => line.includes("Enter send • Ctrl+R bring back • Shift+Tab thinking • Ctrl+C exit")));
});

test("the composer submits a trimmed question and rejects an empty one", () => {
  const { view, actions } = createView();
  view.handleInput(KEYS.enter);
  assert.match(view.render(100).join("\n"), /Question cannot be empty/u);
  for (const character of "  why?  ") view.handleInput(character);
  view.handleInput(KEYS.enter);
  assert.deepEqual(actions, ["submit:why?"]);
  assert.equal(view.getDraft(), "");
});

test("the thinking key cycles supported levels", () => {
  const { view, actions } = createView();
  view.handleInput(KEYS.shiftTab);
  view.handleInput(KEYS.shiftTab);
  assert.deepEqual(actions, ["thinking:high", "thinking:off"]);
  assert.match(view.render(100)[0] ?? "", /thinking off/u);
});

test("an answering view shows its status and cancels with Ctrl+C", () => {
  const { view, actions } = createView(answered);
  view.startAnswer("Q2", "collecting repository facts…");
  const screen = view.render(100).join("\n");
  assert.match(screen, /Q2/u);
  assert.match(screen, /collecting repository facts…/u);
  assert.match(screen, /Ctrl\+C cancel/u);
  view.handleInput(KEYS.ctrlR);
  assert.match(view.render(100).join("\n"), /Wait for the answer/u);
  view.handleInput(KEYS.ctrlC);
  view.handleInput(KEYS.ctrlC);
  assert.deepEqual(actions, ["exit"]);
});

test("terminal controls in answers are escaped", () => {
  const { view } = createView([{ question: "q", answer: "evil \u001b]52;c;payload\u0007", at: 1, model: "m" }]);
  assert.match(view.render(100).join("\n"), /evil \\x1b\]52;c;payload\\x07/u);
});

test("disposing the view exits exactly once", () => {
  const { view, actions } = createView();
  view.dispose();
  view.dispose();
  view.handleInput("x");
  assert.deepEqual(actions, ["exit"]);
});

test("the fullscreen host owns the terminal while the workspace runs and restores it after", async () => {
  const events: string[] = [];
  const parent = {
    terminal: { rows: 24, columns: 80 },
    stop: () => events.push("parent.stop"),
    start: () => events.push("parent.start"),
    renderNow: () => events.push("parent.render"),
  } as unknown as TUI;
  let root: Component | undefined;
  const screen = {
    terminal: { drainInput: async () => events.push("drain") },
    start: () => events.push("screen.start"),
    stop: () => events.push("screen.stop"),
    setLayoutRoot: (component: Component | undefined) => {
      root = component;
      events.push(component ? "layout" : "layout.clear");
    },
    setFocus: () => events.push("focus"),
    requestRender() {},
  } as unknown as BtwScreen;
  let finish: ((value: string) => void) | undefined;
  const layout = { render: () => [], invalidate() {} };
  const ctx = {
    ui: {
      custom: (factory: (...args: unknown[]) => Component, options: { onHandle(handle: unknown): void }) =>
        new Promise((resolve) => {
          factory(parent, plainTheme, testKeybindings, resolve);
          options.onHandle({ setHidden: (hidden: boolean) => events.push(`overlay.hidden:${hidden}`) });
        }),
    },
  };
  const result = runBtwFullscreen<string>(
    ctx as never,
    (_screen, _theme, _keybindings, done) => {
      finish = done;
      return { render: () => [], invalidate() {}, getFullscreenLayout: () => layout, dispose: () => events.push("dispose") };
    },
    () => screen,
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(root, layout);
  assert.deepEqual(events, ["parent.stop", "screen.start", "layout", "focus"]);
  finish?.("value");
  assert.equal(await result, "value");
  assert.deepEqual(events.slice(4), [
    "drain",
    "dispose",
    "layout.clear",
    "screen.stop",
    "overlay.hidden:true",
    "parent.start",
    "parent.render",
  ]);
});

test("the workspace screen swallows the transcript search key", () => {
  const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);
  const terminal = { columns: 80, rows: 24, start() {}, stop() {}, write() {}, hideCursor() {}, showCursor() {} };
  const parent = { terminal, getShowHardwareCursor: () => false } as unknown as TUI;
  const screen = createBtwScreen(parent, plainTheme as never, keybindings as never);
  const handle = Reflect.get(screen, "handleViewportInput") as (data: string) => unknown;
  assert.deepEqual(handle("\u001b[102;6u"), { consume: true });
  assert.equal(Reflect.get(screen, "activeSearch"), undefined);
});
