import {
	copyToClipboard,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type SessionTreeNode,
	TreeSelectorComponent,
} from "@earendil-works/pi-coding-agent";
import { type Component, type Focusable, Key, matchesKey } from "@earendil-works/pi-tui";
import { showBtwCustomPreservingEditor } from "./menu.js";
import { sanitizeSingleLine } from "./text.js";

export type MainThreadTreePickerResult =
	| { kind: "selected"; entryId: string }
	| { kind: "back" }
	| { kind: "closed" };

export interface MainThreadTreeSelector extends Component, Focusable {
	onCopy?: (text: string | undefined) => void;
	dispose?(): void;
}

export interface MainThreadTreeSelectorOptions {
	tree: SessionTreeNode[];
	currentLeafId: string | null;
	terminalRows: number;
	onSelect: (entryId: string) => void;
	onCancel: () => void;
	onCopy: (text: string | undefined) => void;
	onLabelChange: (entryId: string, label: string | undefined) => void;
}

export interface MainThreadTreePickerDependencies {
	createSelector?: (options: MainThreadTreeSelectorOptions) => MainThreadTreeSelector;
	copyToClipboard?: (text: string) => Promise<void>;
}

class MainThreadTreePickerComponent implements Component, Focusable {
	constructor(
		private readonly selector: MainThreadTreeSelector,
		private readonly onClose: () => void,
	) {}

	get focused(): boolean {
		return this.selector.focused;
	}

	set focused(value: boolean) {
		this.selector.focused = value;
	}

	get wantsKeyRelease(): boolean | undefined {
		return this.selector.wantsKeyRelease;
	}

	render(width: number): string[] {
		return this.selector.render(width);
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.ctrl("c"))) {
			this.onClose();
			return;
		}
		this.selector.handleInput?.(data);
	}

	invalidate(): void {
		this.selector.invalidate();
	}

	dispose(): void {
		this.selector.dispose?.();
		this.onClose();
	}
}

export async function showMainThreadTreePicker(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	dependencies: MainThreadTreePickerDependencies = {},
): Promise<MainThreadTreePickerResult> {
	let tree: SessionTreeNode[];
	let currentLeafId: string | null;
	try {
		tree = ctx.sessionManager.getTree();
		currentLeafId = ctx.sessionManager.getLeafId();
	} catch {
		return { kind: "closed" };
	}

	if (tree.length === 0) {
		notifySafely(ctx, "No main-thread entries are available", "warning");
		return { kind: "back" };
	}

	const createSelector = dependencies.createSelector ?? createNativeTreeSelector;
	const copy = dependencies.copyToClipboard ?? copyToClipboard;
	const result = await showBtwCustomPreservingEditor<MainThreadTreePickerResult>(
		ctx,
		(tui, _theme, _keybindings, done) => {
			let settled = false;
			const finish = (value: MainThreadTreePickerResult) => {
				if (settled) return;
				settled = true;
				done(value);
			};
			const onCopy = (text: string | undefined) => {
				if (settled) return;
				if (!text) {
					notifySafely(ctx, "Selected entry has no text to copy", "warning");
					return;
				}
				void copy(text)
					.then(() => {
						if (!settled) notifySafely(ctx, "Copied selected message", "info");
					})
					.catch((error: unknown) => {
						if (!settled) {
							notifySafely(ctx, `Could not copy selected message: ${formatError(error)}`, "error");
						}
					});
			};
			const onLabelChange = (entryId: string, label: string | undefined) => {
				if (settled) return;
				try {
					if (!ctx.sessionManager.getEntry(entryId)) {
						notifySafely(ctx, "The selected main-thread entry is no longer available", "warning");
						return;
					}
					pi.setLabel(entryId, label);
				} catch (error: unknown) {
					notifySafely(ctx, `Could not update tree label: ${formatError(error)}`, "error");
				}
			};
			const selector = createSelector({
				tree,
				currentLeafId,
				terminalRows: tui.terminal.rows,
				onSelect: (entryId) => finish({ kind: "selected", entryId }),
				onCancel: () => finish({ kind: "back" }),
				onCopy,
				onLabelChange,
			});
			return new MainThreadTreePickerComponent(selector, () => finish({ kind: "closed" }));
		},
	);

	return result ?? { kind: "closed" };
}

function createNativeTreeSelector(options: MainThreadTreeSelectorOptions): MainThreadTreeSelector {
	const selector = new TreeSelectorComponent(
		options.tree,
		options.currentLeafId,
		options.terminalRows,
		options.onSelect,
		options.onCancel,
		options.onLabelChange,
	);
	selector.onCopy = options.onCopy;
	return selector;
}

function notifySafely(
	ctx: ExtensionCommandContext,
	message: string,
	level: Parameters<ExtensionCommandContext["ui"]["notify"]>[1],
): void {
	try {
		ctx.ui.notify(sanitizeSingleLine(message), level);
	} catch {
		// The command context may have been replaced while the selector was open.
	}
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
