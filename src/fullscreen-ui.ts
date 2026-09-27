import { spawn } from "node:child_process";
import {
  copyToClipboard as copyToHostClipboard,
  type ExtensionCommandContext,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type OverlayHandle,
  type TUI,
  TuiAltScreen,
  type TuiInputListenerResult,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import { formatKeyLabel } from "./text.js";

/** The one component mounted for the whole time the workspace is open. */
export interface BtwWorkspaceComponent extends Component {
  getFullscreenLayout?(): Component;
  dispose?(): void;
}

export type BtwWorkspaceFactory<T> = (
  screen: BtwScreen,
  theme: Theme,
  keybindings: KeybindingsManager,
  done: (value: T) => void,
) => BtwWorkspaceComponent;

export type BtwScreen = TUI & {
  setLayoutRoot(component: Component | undefined): void;
  flash?(message: string, durationMs?: number): void;
};

export type BtwScreenFactory = (parent: TUI, theme: Theme, keybindings: KeybindingsManager) => BtwScreen;

type Outcome<T> = { kind: "done"; value: T } | { kind: "disposed" } | { kind: "failed"; error: unknown };

/**
 * Run the workspace in its own alternate screen: stop pi's TUI, mount one component,
 * and give the terminal back when it finishes. Resolves undefined when pi disposed it.
 */
export async function runBtwFullscreen<T>(
  ctx: Pick<ExtensionCommandContext, "ui">,
  mount: BtwWorkspaceFactory<T>,
  createScreen: BtwScreenFactory = createBtwScreen,
): Promise<T | undefined> {
  let host: BtwFullscreenHost<T> | undefined;
  const outcome = await ctx.ui.custom<Outcome<T>>(
    (parent, theme, keybindings, done) => {
      host = new BtwFullscreenHost(parent, theme, keybindings, mount, createScreen, done);
      return host;
    },
    { overlay: true, onHandle: (handle) => host?.setOverlay(handle) },
  );
  if (outcome.kind === "failed") throw outcome.error;
  return outcome.kind === "done" ? outcome.value : undefined;
}

class BtwFullscreenHost<T> implements Component {
  private screen: BtwScreen | undefined;
  private workspace: BtwWorkspaceComponent | undefined;
  private overlay: OverlayHandle | undefined;
  private parentStopped = false;
  private settled = false;

  constructor(
    private readonly parent: TUI,
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly mount: BtwWorkspaceFactory<T>,
    private readonly createScreen: BtwScreenFactory,
    private readonly finish: (outcome: Outcome<T>) => void,
  ) {
    queueMicrotask(() => this.start());
  }

  setOverlay(overlay: OverlayHandle): void {
    this.overlay = overlay;
  }

  render(width: number): string[] {
    return [truncateToWidth(this.theme.fg("muted", "Opening btw side thread…"), width)];
  }

  invalidate(): void {}

  dispose(): void {
    this.close({ kind: "disposed" });
  }

  private start(): void {
    if (this.settled) return;
    try {
      this.parent.stop({ preserveScreen: true });
      this.parentStopped = true;
      const screen = this.createScreen(this.parent, this.theme, this.keybindings);
      this.screen = screen;
      screen.start();
      this.workspace = this.mount(screen, this.theme, this.keybindings, (value) => this.close({ kind: "done", value }));
      if (this.settled) return;
      screen.setLayoutRoot(this.workspace.getFullscreenLayout?.() ?? this.workspace);
      screen.setFocus(this.workspace);
      screen.requestRender();
    } catch (error) {
      this.close({ kind: "failed", error });
    }
  }

  /**
   * Restore the parent after the current input dispatch unwinds and pending input
   * drains: stopping the screen destroys its input buffer, so keys already typed
   * behind Ctrl+C must not leak into pi's editor.
   */
  private close(outcome: Outcome<T>): void {
    if (this.settled) return;
    this.settled = true;
    void Promise.resolve().then(async () => {
      let result = outcome;
      const fail = (error: unknown) => {
        if (result.kind !== "failed") result = { kind: "failed", error };
      };
      try {
        await this.screen?.terminal.drainInput?.();
      } catch (error) {
        fail(error);
      }
      try {
        this.workspace?.dispose?.();
      } catch {
        // Cleanup must continue so terminal ownership is restored.
      }
      try {
        this.screen?.setLayoutRoot(undefined);
        this.screen?.stop({ preserveScreen: true });
      } catch (error) {
        fail(error);
      }
      try {
        this.overlay?.setHidden(true);
      } catch (error) {
        fail(error);
      }
      if (this.parentStopped) {
        try {
          this.parent.start();
          this.parent.renderNow(false);
        } catch (error) {
          fail(error);
        }
      }
      this.finish(result);
    });
  }
}

/** pi's alternate screen with mouse selection copied on release and transcript search disabled. */
export function createBtwScreen(parent: TUI, theme: Theme, keybindings: KeybindingsManager): BtwScreen {
  const bottomKey = keybindings.getKeys("tui.altScreen.bottom")[0];
  const screen = new TuiAltScreen(parent.terminal, parent.getShowHardwareCursor(), undefined, {
    mouse: true,
    copyOnSelect: true,
    scrollToEndIndicator: () => {
      const shortcut = bottomKey ? theme.fg("muted", ` · ${formatKeyLabel(String(bottomKey))}`) : "";
      return theme.bg("selectedBg", `${theme.fg("text", " ↓ Jump to latest message")}${shortcut} `);
    },
    openUrl: openUrlInBrowser,
    copySelection: async (text) => {
      try {
        await copyToHostClipboard(text);
        return true;
      } catch {
        return false;
      }
    },
  });
  // The viewport handler owns the search key; swallow it so search never opens.
  const handleViewportInput = Reflect.get(screen, "handleViewportInput") as (data: string) => TuiInputListenerResult;
  Reflect.set(screen, "handleViewportInput", (data: string): TuiInputListenerResult => {
    return keybindings.matches(data, "tui.altScreen.search") ? { consume: true } : handleViewportInput.call(screen, data);
  });
  return screen;
}

// Pi does not export its browser opener, so mirror its shell-free launcher for this isolated TUI.
function openUrlInBrowser(target: string): void {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [target]]
      : process.platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", target]]
        : ["xdg-open", [target]];
  spawn(command, args, { stdio: "ignore", detached: true })
    .on("error", () => {})
    .unref();
}
