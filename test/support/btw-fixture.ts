import type { Api, AssistantMessage, Context, Model, ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";
import { initTheme } from "@earendil-works/pi-coding-agent";
import btw, { type BtwExtensionDependencies } from "../../src/btw.js";
import type { BtwWorkspaceFactory } from "../../src/fullscreen-ui.js";
import { type BtwSettings, DEFAULT_BTW_SETTINGS } from "../../src/settings.js";
import type { CompleteSimpleFunction } from "../../src/side-thread.js";
import type { BtwWorkspaceView } from "../../src/workspace.js";
import { createMockContext, createMockPi } from "./pi-mock.js";

export const sideModel = { provider: "test", id: "side", reasoning: true } as unknown as Model<Api>;

export const plainTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  underline: (text: string) => text,
  inverse: (text: string) => text,
  strikethrough: (text: string) => text,
};

export const testKeybindings = {
  getKeys: (action: string) => (action === "app.thinking.cycle" ? ["shift+tab"] : []),
  matches: () => false,
};

export function assistant(text: string, overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
    timestamp: Date.now(),
    api: "test",
    provider: "test",
    model: "side",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    ...overrides,
  } as AssistantMessage;
}

export interface SideRequest {
  context: Context;
  options?: ModelsSimpleStreamOptions;
}

type Answer = string | Error | ((request: SideRequest) => Promise<AssistantMessage>);

export interface BtwHarnessOptions {
  branch?: unknown[];
  editorText?: string;
  answers?: Answer[];
  settings?: Partial<BtwSettings>;
  warnings?: string[];
  mode?: string;
  isIdle?: () => boolean;
  editor?: (title: string, prefill?: string) => Promise<string | undefined>;
  dependencies?: BtwExtensionDependencies;
}

/** The extension on the mock pi, with a fake model and the workspace mounted without a terminal. */
export function createBtwHarness(options: BtwHarnessOptions = {}) {
  initTheme("dark");
  const mock = createMockPi();
  const branch = options.branch ?? [];
  const answers = [...(options.answers ?? [])];
  const requests: SideRequest[] = [];
  let view: BtwWorkspaceView | undefined;
  let workspaceOpen = false;
  const completeSimple: CompleteSimpleFunction = async (_model, context, streamOptions) => {
    const request = { context, options: streamOptions };
    requests.push(request);
    const answer = answers.shift() ?? `answer ${requests.length}`;
    if (typeof answer === "function") return answer(request);
    if (answer instanceof Error) throw answer;
    return assistant(answer);
  };
  const mockContext = createMockContext({
    mode: options.mode ?? "tui",
    model: sideModel,
    editorText: options.editorText,
    // The mock spreads its overrides last, so leave out what the test did not set.
    ...(options.isIdle ? { isIdle: options.isIdle } : {}),
    ...(options.editor ? { editor: options.editor } : {}),
    cwd: process.cwd(),
    sessionManager: {
      getBranch: () => branch,
      getEntries: () => branch,
      getSessionId: () => "main-session",
    },
    modelRegistry: {
      find: () => undefined,
      getAvailable: () => [sideModel],
      streamSimple: () => {
        throw new Error("the harness completes through createCompleteSimple");
      },
    },
  });
  const ctx = mockContext.ctx;
  // Like pi, appended custom entries join the branch.
  const appendEntry = mock.rawPi.appendEntry.bind(mock.rawPi);
  mock.rawPi.appendEntry = (customType: string, data: unknown) => {
    appendEntry(customType, data);
    branch.push({ type: "custom", customType, data, id: `custom-${branch.length}`, timestamp: new Date().toISOString() });
  };
  btw(mock.pi, {
    readSettings: async () => ({ settings: { ...DEFAULT_BTW_SETTINGS, liveFacts: false, ...options.settings }, warnings: options.warnings ?? [] }),
    createCompleteSimple: () => completeSimple,
    runFullscreen: (async <T>(_ctx: unknown, mount: BtwWorkspaceFactory<T>) => {
      workspaceOpen = true;
      const screen = { terminal: { rows: 30, columns: 100 }, requestRender() {} };
      const value = await new Promise<T>((resolve) => {
        view = mount(screen as never, plainTheme as never, testKeybindings as never, resolve) as BtwWorkspaceView;
      });
      workspaceOpen = false;
      return value;
    }) as BtwExtensionDependencies["runFullscreen"],
    ...options.dependencies,
  });
  const emit = async (event: string, payload: Record<string, unknown> = {}) => {
    for (const handler of mock.events.get(event) ?? []) await handler({ type: event, ...payload }, ctx);
  };
  return {
    mock,
    ctx: ctx as never,
    notifications: mockContext.notifications,
    branch,
    requests,
    emit,
    get view() {
      if (!view) throw new Error("the workspace never opened");
      return view;
    },
    get workspaceOpen() {
      return workspaceOpen;
    },
    get editorText() {
      return (ctx as { ui: { getEditorText(): string } }).ui.getEditorText();
    },
    /** Run `/btw <args>`; resolves when the workspace closes. */
    run(args = "") {
      const command = mock.commands.get("btw");
      if (!command) throw new Error("/btw was not registered");
      return command.handler(args, ctx) as Promise<void>;
    },
    type(text: string) {
      for (const character of text) this.view.handleInput(character);
    },
    press(data: string) {
      this.view.handleInput(data);
    },
    /** Let pending promises (answers, persistence) settle. */
    async settle() {
      for (let index = 0; index < 20; index += 1) await new Promise((resolve) => setImmediate(resolve));
    },
    /** The text of the side request's single user message. */
    promptOf(index = requests.length - 1) {
      const message = requests[index]?.context.messages[0];
      const content = message?.content;
      return Array.isArray(content) ? content.map((part) => ("text" in part ? part.text : "")).join("") : String(content ?? "");
    },
  };
}

export const KEYS = {
  enter: "\r",
  ctrlC: "\u0003",
  ctrlR: "\u0012",
  ctrlN: "\u000e",
  shiftTab: "\u001b[Z",
};
