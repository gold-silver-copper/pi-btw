import assert from "node:assert/strict";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { type BtwFullscreenTuiFactory, runBtwFullscreen } from "../src/fullscreen-ui.js";

interface FakeComponent extends Component {
	dispose(): void;
}

function createHarness(options: { fullscreenStopError?: Error } = {}) {
	const events: string[] = [];
	let outerComponent: FakeComponent | undefined;
	let outerDone: ((value: unknown) => void) | undefined;
	let editorText = "main draft";
	const parent = {
		mode: "regular",
		terminal: { rows: 24, columns: 80 },
		getShowHardwareCursor: () => false,
		stop: (options?: { preserveScreen?: boolean }) => {
			events.push(`parent.stop:${String(options?.preserveScreen)}`);
		},
		start: () => events.push("parent.start"),
		requestRender: (force?: boolean) => events.push(`parent.render:${String(force)}`),
	} as unknown as TUI;
	let active: Component | undefined;
	const fullscreen = {
		mode: "fullscreen",
		terminal: parent.terminal,
		children: [] as Component[],
		clear() {
			events.push("fullscreen.clear");
			active = undefined;
		},
		addChild(component: Component) {
			events.push("fullscreen.add");
			active = component;
		},
		removeChild(component: Component) {
			events.push("fullscreen.remove");
			if (active === component) active = undefined;
		},
		setFocus(component: Component | null) {
			events.push(component ? "fullscreen.focus" : "fullscreen.unfocus");
		},
		start() {
			events.push("fullscreen.start");
		},
		stop(stopOptions?: { preserveScreen?: boolean }) {
			events.push(`fullscreen.stop:${String(stopOptions?.preserveScreen)}`);
			if (options.fullscreenStopError) throw options.fullscreenStopError;
		},
		requestRender() {
			events.push("fullscreen.render");
		},
		showOverlay() {
			throw new Error("overlay was not expected");
		},
		flash(message: string) {
			events.push(`fullscreen.flash:${message}`);
		},
	} as unknown as TUI;
	const createTui: BtwFullscreenTuiFactory = () => fullscreen;
	const notifications: string[] = [];
	const ctx = {
		ui: {
			custom: async (factory: (...args: never[]) => FakeComponent) => {
				const savedEditorText = editorText;
				const result = new Promise<unknown>((resolve) => {
					outerDone = resolve;
				});
				outerComponent = factory(
					parent as never,
					{
						fg: (_color: string, text: string) => text,
						bold: (text: string) => text,
					} as never,
					{} as never,
					((value: unknown) => outerDone?.(value)) as never,
				);
				const value = await result;
				editorText = savedEditorText;
				return value;
			},
			notify(message: string) {
				notifications.push(message);
			},
			getEditorText: () => editorText,
			setEditorText: (value: string) => {
				editorText = value;
			},
		},
	} as never;
	return {
		ctx,
		createTui,
		events,
		notifications,
		get outerComponent() {
			return outerComponent;
		},
		get editorText() {
			return editorText;
		},
	};
}

function immediateComponent(done: (value: string) => void, events: string[]): FakeComponent {
	done("side result");
	return {
		render: () => ["side"],
		invalidate() {},
		dispose() {
			events.push("component.dispose");
		},
	};
}

test("default fullscreen enables application-owned mouse selection and restores terminal modes", async () => {
	const writes: string[] = [];
	let outerDone: ((value: unknown) => void) | undefined;
	const terminal = {
		columns: 80,
		rows: 24,
		start() {},
		stop() {},
		write(data: string) {
			writes.push(data);
		},
		hideCursor() {},
		showCursor() {},
	} as never;
	const parent = {
		mode: "regular",
		terminal,
		getShowHardwareCursor: () => false,
		stop() {},
		start() {},
		requestRender() {},
	} as unknown as TUI;
	let editorText = "main draft";
	const ctx = {
		ui: {
			custom: async (factory: (...args: never[]) => FakeComponent) => {
				const result = new Promise<unknown>((resolve) => {
					outerDone = resolve;
				});
				factory(
					parent as never,
					{ fg: (_color: string, text: string) => text } as never,
					{} as never,
					((value: unknown) => outerDone?.(value)) as never,
				);
				return result;
			},
			getEditorText: () => editorText,
			setEditorText: (value: string) => {
				editorText = value;
			},
		},
	} as never;

	assert.equal(
		await runBtwFullscreen(ctx, (fullscreenCtx) =>
			fullscreenCtx.ui.custom((_tui, _theme, _keys, done) => immediateComponent(done, [])),
		),
		"side result",
	);
	const output = writes.join("");
	for (const sequence of ["\u001b[?1049h", "\u001b[?1002h", "\u001b[?1006h"]) {
		assert.equal(
			output.includes(sequence),
			true,
			`missing enable sequence ${JSON.stringify(sequence)}`,
		);
	}
	for (const sequence of ["\u001b[?1006l", "\u001b[?1002l", "\u001b[?1049l"]) {
		assert.equal(
			output.includes(sequence),
			true,
			`missing cleanup sequence ${JSON.stringify(sequence)}`,
		);
	}
});

test("dedicated fullscreen owns the terminal while side custom UI runs and restores it afterward", async () => {
	const harness = createHarness();
	const result = await runBtwFullscreen(
		harness.ctx,
		async (ctx) => {
			ctx.ui.notify("side notice", "info");
			assert.equal(ctx.ui.getEditorText(), "main draft");
			ctx.ui.setEditorText("brought side context");
			return ctx.ui.custom<string>((tui, _theme, _keys, done) => {
				assert.equal(tui.mode, "fullscreen");
				return immediateComponent(done, harness.events);
			});
		},
		{ createTui: harness.createTui },
	);

	assert.equal(result, "side result");
	assert.equal(harness.editorText, "brought side context");
	assert.deepEqual(harness.notifications, ["side notice"]);
	assert.deepEqual(harness.events, [
		"parent.stop:true",
		"fullscreen.start",
		"fullscreen.flash:side notice",
		"component.dispose",
		"fullscreen.stop:true",
		"parent.start",
		"parent.render:true",
	]);
});

test("dedicated fullscreen restores the parent before propagating a side-flow error", async () => {
	const harness = createHarness();
	await assert.rejects(
		runBtwFullscreen(
			harness.ctx,
			async () => {
				throw new Error("side failed");
			},
			{ createTui: harness.createTui },
		),
		/side failed/,
	);

	assert.deepEqual(harness.events, [
		"parent.stop:true",
		"fullscreen.start",
		"fullscreen.stop:true",
		"parent.start",
		"parent.render:true",
	]);
});

test("a fullscreen stop failure still restarts the parent before it propagates", async () => {
	const harness = createHarness({ fullscreenStopError: new Error("fullscreen stop failed") });
	await assert.rejects(
		runBtwFullscreen(harness.ctx, async () => "done", { createTui: harness.createTui }),
		/fullscreen stop failed/,
	);

	assert.deepEqual(harness.events, [
		"parent.stop:true",
		"fullscreen.start",
		"fullscreen.stop:true",
		"parent.start",
		"parent.render:true",
	]);
});

test("disposing the fullscreen host closes active side UI and restores terminal ownership once", async () => {
	const harness = createHarness();
	let closeSide: (() => void) | undefined;
	const running = runBtwFullscreen(
		harness.ctx,
		(ctx) =>
			ctx.ui.custom<"closed">((_tui, _theme, _keys, done) => {
				closeSide = () => done("closed");
				return {
					render: () => ["waiting"],
					invalidate() {},
					dispose() {
						harness.events.push("component.dispose");
						closeSide?.();
					},
				};
			}),
		{ createTui: harness.createTui },
	);
	await Promise.resolve();
	await Promise.resolve();
	assert.ok(harness.outerComponent);
	harness.outerComponent.dispose();
	harness.outerComponent.dispose();

	assert.equal(await running, "closed");
	assert.equal(harness.events.filter((event) => event === "fullscreen.stop:true").length, 1);
	assert.equal(harness.events.filter((event) => event === "parent.start").length, 1);
	assert.equal(harness.events.filter((event) => event === "component.dispose").length, 1);
});

test("disposal restores the parent and disposes a custom component whose factory settles late", async () => {
	const harness = createHarness();
	let releaseFactory: ((component: FakeComponent) => void) | undefined;
	const running = runBtwFullscreen(
		harness.ctx,
		(ctx) =>
			ctx.ui.custom(
				(_tui, _theme, _keys, _done) =>
					new Promise<FakeComponent>((resolve) => {
						releaseFactory = resolve;
					}),
			),
		{ createTui: harness.createTui },
	);
	await Promise.resolve();
	await Promise.resolve();
	assert.ok(harness.outerComponent);
	harness.outerComponent.dispose();
	await assert.rejects(running, /dedicated pi-btw UI was disposed/i);
	assert.ok(releaseFactory);
	releaseFactory({
		render: () => ["late"],
		invalidate() {},
		dispose() {
			harness.events.push("late-component.dispose");
		},
	});
	await Promise.resolve();
	await Promise.resolve();

	assert.equal(harness.events.filter((event) => event === "fullscreen.stop:true").length, 1);
	assert.equal(harness.events.filter((event) => event === "parent.start").length, 1);
	assert.equal(harness.events.filter((event) => event === "late-component.dispose").length, 1);
});
