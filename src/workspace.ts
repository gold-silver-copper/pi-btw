import { getMarkdownTheme, type Theme, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Editor,
  type EditorTheme,
  type Focusable,
  getKeybindings,
  Key,
  Loader,
  Markdown,
  matchesKey,
  ScrollView,
  type TUI,
  truncateToWidth,
  VStack,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { BtwWorkspaceComponent } from "./fullscreen-ui.js";
import { BtwPasteGuard, type BtwShortcuts } from "./keybindings.js";
import type { BtwThinkingLevel } from "./settings.js";
import type { BtwTurn } from "./side-thread.js";

const OSC133_MARKERS = ["\u001b]133;A\u0007", "\u001b]133;B\u0007", "\u001b]133;C\u0007"];

// A temporary fit after manual scrolling must not silently resume following new output.
class PreservingScrollView extends ScrollView {
  override updateLayout(contentHeight: number, viewportHeight: number, requestRender: () => void): void {
    const preserveManualPosition = !this.isFollowingEnd;
    super.updateLayout(contentHeight, viewportHeight, requestRender);
    if (preserveManualPosition && this.isFollowingEnd) {
      this.scrollTo(this.scrollTop, { disableFollow: true });
    }
  }
}

export interface BtwWorkspaceHandlers {
  /** Ask a question; the controller calls `startAnswer` and `finishAnswer`. */
  submit(question: string): void;
  bringBack(): void;
  /** Close the workspace and steer the main agent, starting from the composer's draft. */
  steer(draft: string): void;
  cycleThinking(level: BtwThinkingLevel): void;
  exit(): void;
}

export interface BtwWorkspaceOptions {
  /** The thread's turns; read again on every `refresh`. */
  turns: readonly BtwTurn[];
  model: string;
  thinkingLevel: BtwThinkingLevel;
  thinkingLevels: readonly BtwThinkingLevel[];
  shortcuts: BtwShortcuts;
  handlers: BtwWorkspaceHandlers;
  /** Composer text to start with. */
  draft?: string;
}

/** Fullscreen side thread: header, transcript, footer and composer. */
export class BtwWorkspaceView implements BtwWorkspaceComponent, Focusable {
  private readonly pasteGuard = new BtwPasteGuard();
  private readonly editor: Editor;
  private readonly loader: Loader;
  private readonly scrollView: ScrollView;
  private readonly layoutRoot: VStack;
  private transcript: Component[] = [];
  private pending: string | undefined;
  private warning: string | undefined;
  private thinkingLevel: BtwThinkingLevel;
  private closed = false;
  private isFocused = false;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly options: BtwWorkspaceOptions,
  ) {
    this.thinkingLevel = options.thinkingLevel;
    const accent = (text: string) => theme.fg("accent", text);
    const editorTheme: EditorTheme = {
      borderColor: accent,
      selectList: {
        selectedPrefix: accent,
        selectedText: accent,
        description: (text) => theme.fg("muted", text),
        scrollInfo: (text) => theme.fg("dim", text),
        noMatch: (text) => theme.fg("warning", text),
      },
    };
    this.editor = new Editor(tui, editorTheme);
    if (options.draft) this.editor.setText(options.draft);
    this.editor.onChange = () => {
      this.warning = undefined;
    };
    this.editor.onSubmit = (text) => this.submit(text);
    this.loader = new Loader(tui, accent, (text) => theme.fg("muted", text), "Answering…");
    this.loader.stop();
    const line = (render: (width: number) => string): Component => ({ render: (width) => [render(width)], invalidate() {} });
    this.scrollView = new PreservingScrollView(
      {
        render: (width) => this.transcript.flatMap((component) => component.render(width)).map(stripShellIntegrationMarkers),
        invalidate: () => {
          for (const component of this.transcript) component.invalidate();
        },
      },
      { follow: "end", primary: true },
    );
    this.layoutRoot = new VStack([
      { component: line((width) => this.renderHeader(width)), basis: 1, shrink: 0, minSize: 1 },
      { component: this.scrollView, basis: 0, grow: 1, minSize: 0 },
      { component: line((width) => this.renderFooter(width)), basis: 1, shrink: 0, minSize: 1 },
      { component: this.editor, basis: "auto", shrink: 1, minSize: 0 },
    ]);
    this.refresh();
  }

  get focused(): boolean {
    return this.isFocused;
  }

  set focused(value: boolean) {
    this.isFocused = value;
    this.editor.focused = value;
  }

  get answering(): boolean {
    return this.pending !== undefined;
  }

  getFullscreenLayout(): Component {
    return this.layoutRoot;
  }

  getDraft(): string {
    return this.editor.getExpandedText();
  }

  /** Show the question and a status line while its answer is prepared. */
  startAnswer(question: string, status = "Answering…"): void {
    this.pending = question;
    this.loader.setMessage(status);
    this.loader.start();
    this.refresh();
  }

  setStatus(status: string): void {
    this.loader.setMessage(status);
    this.tui.requestRender();
  }

  finishAnswer(): void {
    this.pending = undefined;
    this.loader.stop();
    this.refresh();
  }

  /** Rebuild the transcript from the thread's turns. */
  refresh(): void {
    const markdownTheme = getMarkdownTheme();
    this.transcript = this.options.turns.flatMap((turn): Component[] => [
      new UserMessageComponent(escapeTerminalControls(turn.question), markdownTheme, 1),
      turn.error
        ? new Markdown(`Error: ${escapeTerminalControls(turn.answer)}`, 1, 1, markdownTheme, {
            color: (text) => this.theme.fg("error", text),
          })
        : new Markdown(escapeTerminalControls(turn.answer), 1, 1, markdownTheme),
    ]);
    if (this.pending !== undefined) {
      this.transcript.push(new UserMessageComponent(escapeTerminalControls(this.pending), markdownTheme, 1));
    }
    this.scrollView.scrollToEnd();
    this.layoutRoot.invalidate();
    this.tui.requestRender();
  }

  /** Plain rendering for callers without a layout engine. */
  render(width: number): string[] {
    return [
      this.renderHeader(width),
      ...this.transcript.flatMap((component) => component.render(width)).map(stripShellIntegrationMarkers),
      this.renderFooter(width),
      ...this.editor.render(width),
    ];
  }

  handleInput(data: string): void {
    if (this.closed) return;
    const { shortcuts, handlers } = this.options;
    if (this.pasteGuard.consume(data)) {
      this.editor.handleInput(data);
      this.tui.requestRender();
      return;
    }
    if (shortcuts.matches(data, "exit")) {
      this.close();
      handlers.exit();
      return;
    }
    if (shortcuts.matches(data, "bringBack")) {
      if (this.answering) this.warn("Wait for the answer, or Ctrl+C to cancel");
      else if (!this.options.turns.some((turn) => !turn.error)) this.warn("Nothing to bring back yet");
      else {
        this.close();
        handlers.bringBack();
      }
      return;
    }
    if (shortcuts.matches(data, "steer")) {
      if (this.answering) this.warn("Wait for the answer, or Ctrl+C to cancel");
      else {
        this.close();
        handlers.steer(this.getDraft());
      }
      return;
    }
    if (shortcuts.matches(data, "cycleThinking")) {
      const levels = this.options.thinkingLevels;
      if (levels.length > 1) {
        this.thinkingLevel = levels[(levels.indexOf(this.thinkingLevel) + 1) % levels.length] ?? this.thinkingLevel;
        handlers.cycleThinking(this.thinkingLevel);
        this.tui.requestRender();
      }
      return;
    }
    if (this.answering && getKeybindings().matches(data, "tui.input.submit")) {
      // Keep the draft: the editor clears itself on submit.
      this.warn("Wait for the answer, or Ctrl+C to cancel");
      return;
    }
    if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown)) {
      const page = Math.max(1, this.scrollView.viewportHeight);
      this.scrollView.scrollBy(matchesKey(data, Key.pageUp) ? -page : page);
      this.tui.requestRender();
      return;
    }
    this.editor.handleInput(data);
    this.tui.requestRender();
  }

  invalidate(): void {
    this.layoutRoot.invalidate();
  }

  dispose(): void {
    this.loader.stop();
    if (this.closed) return;
    this.close();
    this.options.handlers.exit();
  }

  private submit(text: string): void {
    const question = text.trim();
    if (!question) {
      this.warn("Question cannot be empty");
      return;
    }
    this.editor.setText("");
    this.editor.addToHistory(question);
    this.options.handlers.submit(question);
  }

  private warn(message: string): void {
    this.warning = message;
    this.tui.requestRender();
  }

  private close(): void {
    this.closed = true;
    this.loader.stop();
  }

  private renderHeader(width: number): string {
    const title = truncateToWidth(`─ btw · ${this.options.model} · thinking ${this.thinkingLevel} `, width);
    return this.theme.fg("muted", `${title}${"─".repeat(Math.max(0, width - visibleWidth(title)))}`);
  }

  private renderFooter(width: number): string {
    if (this.warning) return truncateToWidth(this.theme.fg("warning", this.warning), width);
    const { shortcuts } = this.options;
    const thinking = this.options.thinkingLevels.length > 1 ? shortcuts.label("cycleThinking") : undefined;
    // While answering, only cancelling and the thinking level apply.
    const keys = (
      this.answering
        ? [[shortcuts.label("exit"), "cancel"], [thinking, "thinking"]]
        : [
            ["Enter", "send"],
            [shortcuts.label("bringBack"), "bring back"],
            [shortcuts.label("steer"), "steer"],
            [thinking, "thinking"],
            [shortcuts.label("exit"), "exit"],
          ]
    ).filter((pair): pair is [string, string] => pair[0] !== undefined);
    const status = this.answering ? `${this.loader.render(width).at(-1)?.trim() || "Answering…"} • ` : "";
    const full = keys.map(([key, action]) => `${key} ${action}`).join(" • ");
    const hints = visibleWidth(status + full) <= width ? full : keys.map(([key]) => key).join(" • ");
    return truncateToWidth(status + this.theme.fg("muted", hints), width);
  }
}

function stripShellIntegrationMarkers(line: string): string {
  return OSC133_MARKERS.reduce((result, marker) => result.replaceAll(marker, ""), line);
}

function escapeTerminalControls(text: string): string {
  return [...text]
    .map((character) => {
      if (character === "\n") return character;
      if (character === "\t") return "    ";
      const code = character.charCodeAt(0);
      if (code <= 31 || (code >= 127 && code <= 159)) {
        return `\\x${code.toString(16).padStart(2, "0")}`;
      }
      return character;
    })
    .join("");
}
