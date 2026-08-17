import assert from "node:assert/strict";
import {
	type ExtensionCommandContext,
	initTheme,
	type SessionTreeNode,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { createCustomSelectorHarness, createMockContext } from "../../../test/support.js";
import {
	type MainThreadTreeSelectorOptions,
	showMainThreadTreePicker,
} from "../src/main-thread-tree.js";

function userNode(id: string, parentId: string | null, text: string): SessionTreeNode {
	return {
		entry: {
			type: "message",
			id,
			parentId,
			timestamp: "2026-01-01T00:00:00.000Z",
			message: { role: "user", content: text, timestamp: 1 },
		},
		children: [],
	};
}

function createFakeSelector(onCreate: (options: MainThreadTreeSelectorOptions) => void): (
	options: MainThreadTreeSelectorOptions,
) => {
	focused: boolean;
	render(width: number): string[];
	handleInput(data: string): void;
	invalidate(): void;
} {
	return (options) => {
		onCreate(options);
		return {
			focused: false,
			render: (width) => ["tree".slice(0, width)],
			handleInput(data) {
				if (data === "select") options.onSelect("branch-entry");
				if (data === "escape") options.onCancel();
				if (data === "copy") options.onCopy("copied text");
				if (data === "copy-empty") options.onCopy(undefined);
				if (data === "label") options.onLabelChange("branch-entry", "checkpoint");
			},
			invalidate() {},
		};
	};
}

test("main-thread tree picker passes the session snapshot and current leaf to the selector", async () => {
	const root = userNode("root", null, "root");
	const branch = userNode("branch-entry", "root", "branch");
	root.children.push(branch);
	let captured: MainThreadTreeSelectorOptions | undefined;
	const mock = createMockContext({
		mode: "tui",
		hasUI: true,
		editorText: "main draft",
		sessionManager: {
			getTree: () => [root],
			getLeafId: () => "active-leaf",
			getEntry: (id: string) => (id === "branch-entry" ? branch.entry : undefined),
		},
		custom: async (factory: unknown) => {
			const harness = createCustomSelectorHarness(factory);
			(mock.ctx as ExtensionCommandContext).ui.setEditorText("newer main draft");
			harness.handleInput("select");
			return harness.resultPromise;
		},
	});

	const result = await showMainThreadTreePicker({ setLabel() {} } as never, mock.ctx, {
		createSelector: createFakeSelector((options) => {
			captured = options;
		}),
	});

	assert.deepEqual(result, { kind: "selected", entryId: "branch-entry" });
	assert.deepEqual(captured?.tree, [root]);
	assert.equal(captured?.currentLeafId, "active-leaf");
	assert.equal(mock.editorText, "newer main draft");
});

test("main-thread tree picker reports an empty tree without opening custom UI", async () => {
	let customCalls = 0;
	const mock = createMockContext({
		mode: "tui",
		hasUI: true,
		sessionManager: { getTree: () => [], getLeafId: () => null },
		custom: async () => {
			customCalls += 1;
		},
	});

	const result = await showMainThreadTreePicker({ setLabel() {} } as never, mock.ctx);

	assert.deepEqual(result, { kind: "back" });
	assert.equal(customCalls, 0);
	assert.deepEqual(mock.notifications, [
		{ message: "No main-thread entries are available", level: "warning" },
	]);
});

test("Escape returns to the menu while Ctrl+C closes the overall tree flow", async () => {
	const node = userNode("branch-entry", null, "branch");
	const run = async (input: string) => {
		const mock = createMockContext({
			mode: "tui",
			hasUI: true,
			sessionManager: {
				getTree: () => [node],
				getLeafId: () => "branch-entry",
				getEntry: () => node.entry,
			},
			custom: async (factory: unknown) => {
				const harness = createCustomSelectorHarness(factory);
				harness.handleInput(input);
				return harness.resultPromise;
			},
		});
		return showMainThreadTreePicker({ setLabel() {} } as never, mock.ctx, {
			createSelector: createFakeSelector(() => {}),
		});
	};

	assert.deepEqual(await run("escape"), { kind: "back" });
	assert.deepEqual(await run("\u0003"), { kind: "closed" });
});

test("native copy success and failure are observable and terminal-safe", async () => {
	const node = userNode("branch-entry", null, "branch");
	const copied: string[] = [];
	const mock = createMockContext({
		mode: "tui",
		hasUI: true,
		sessionManager: {
			getTree: () => [node],
			getLeafId: () => "branch-entry",
			getEntry: () => node.entry,
		},
		custom: async (factory: unknown) => {
			const harness = createCustomSelectorHarness(factory);
			harness.handleInput("copy");
			await new Promise<void>((resolve) => setImmediate(resolve));
			harness.handleInput("escape");
			return harness.resultPromise;
		},
	});
	const createSelector = createFakeSelector(() => {});

	await showMainThreadTreePicker({ setLabel() {} } as never, mock.ctx, {
		createSelector,
		copyToClipboard: async (text) => {
			copied.push(text);
		},
	});
	await showMainThreadTreePicker({ setLabel() {} } as never, mock.ctx, {
		createSelector,
		copyToClipboard: async () => {
			throw new Error("clipboard failed\u001b]52;c;ZXZpbA==\u0007");
		},
	});

	assert.deepEqual(copied, ["copied text"]);
	assert.ok(mock.notifications.some(({ message }) => message === "Copied selected message"));
	const failure = mock.notifications.find(({ level }) => level === "error")?.message ?? "";
	assert.match(failure, /Could not copy selected message: clipboard failed/);
	assert.equal(
		[...failure].some((character) => {
			const code = character.charCodeAt(0);
			return code <= 31 || (code >= 127 && code <= 159);
		}),
		false,
	);
});

test("native label editing writes only after the selector's explicit callback", async () => {
	const node = userNode("branch-entry", null, "branch");
	const labels: Array<{ entryId: string; label: string | undefined }> = [];
	const mock = createMockContext({
		mode: "tui",
		hasUI: true,
		sessionManager: {
			getTree: () => [node],
			getLeafId: () => "branch-entry",
			getEntry: () => node.entry,
		},
		custom: async (factory: unknown) => {
			const harness = createCustomSelectorHarness(factory);
			assert.deepEqual(labels, []);
			harness.handleInput("label");
			harness.handleInput("escape");
			return harness.resultPromise;
		},
	});

	await showMainThreadTreePicker(
		{
			setLabel: (entryId: string, label: string | undefined) => labels.push({ entryId, label }),
		} as never,
		mock.ctx,
		{ createSelector: createFakeSelector(() => {}) },
	);

	assert.deepEqual(labels, [{ entryId: "branch-entry", label: "checkpoint" }]);
});

test("native tree selector renders within narrow terminal widths", async () => {
	initTheme("dark", false);
	const root = userNode("root", null, "root with a very long untrusted-looking message");
	const mock = createMockContext({
		mode: "tui",
		hasUI: true,
		sessionManager: {
			getTree: () => [root],
			getLeafId: () => "root",
			getEntry: () => root.entry,
		},
		custom: async (factory: unknown) => {
			const harness = createCustomSelectorHarness(factory, 28);
			const rendered = harness.render(28);
			assert.ok(rendered.every((line) => visibleWidth(line) <= 28));
			harness.handleInput("\u0003");
			return harness.resultPromise;
		},
	});

	assert.deepEqual(await showMainThreadTreePicker({ setLabel() {} } as never, mock.ctx), {
		kind: "closed",
	});
});

test("disposing the tree picker closes without a stale clipboard notification", async () => {
	const node = userNode("branch-entry", null, "branch");
	let releaseCopy!: () => void;
	const copyPending = new Promise<void>((resolve) => {
		releaseCopy = resolve;
	});
	const mock = createMockContext({
		mode: "tui",
		hasUI: true,
		sessionManager: {
			getTree: () => [node],
			getLeafId: () => "branch-entry",
			getEntry: () => node.entry,
		},
		custom: async (factory: unknown) => {
			const harness = createCustomSelectorHarness(factory);
			harness.handleInput("copy");
			harness.dispose();
			releaseCopy();
			return harness.resultPromise;
		},
	});

	const result = await showMainThreadTreePicker({ setLabel() {} } as never, mock.ctx, {
		createSelector: createFakeSelector(() => {}),
		copyToClipboard: async () => copyPending,
	});

	assert.deepEqual(result, { kind: "closed" });
	await Promise.resolve();
	assert.deepEqual(mock.notifications, []);
});
