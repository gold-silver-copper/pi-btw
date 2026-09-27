import { type Api, clampThinkingLevel, getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { trackMainAgent } from "./activity.js";
import { appendToDraft, formatBtwBringToMain } from "./bring-to-main.js";
import { buildSideContext, objectiveFilePath } from "./context.js";
import { runBtwFullscreen } from "./fullscreen-ui.js";
import { createBtwShortcuts } from "./keybindings.js";
import {
  type CommandRunner,
  collectLiveFacts,
  createCommandRunner,
  LiveFactsCache,
  readPromptFile,
  recentDirectories,
} from "./live-facts.js";
import { type BtwSettings, type BtwSettingsResult, type BtwThinkingLevel, parseBtwModelReference, readBtwSettings } from "./settings.js";
import {
  BTW_THREAD_ENTRY_TYPE,
  type CompleteSimpleFunction,
  completeSideTurn,
  createSideThread,
  MAX_THREAD_TURNS,
  restoreThreadTurns,
  type SideThread,
  serializeThread,
} from "./side-thread.js";
import { sanitizeSingleLine } from "./text.js";
import { BtwWorkspaceView } from "./workspace.js";

type BtwModelRegistry = Pick<ExtensionCommandContext["modelRegistry"], "find" | "getAvailable">;
type BtwCompletionRegistry = Pick<ExtensionCommandContext["modelRegistry"], "streamSimple">;

export type BtwWorkspaceResult = { kind: "closed" } | { kind: "bringBack" } | { kind: "steer"; draft: string };

export interface BtwExtensionDependencies {
  readSettings?: () => Promise<BtwSettingsResult>;
  runFullscreen?: typeof runBtwFullscreen;
  createCompleteSimple?: (modelRegistry: BtwCompletionRegistry) => CompleteSimpleFunction;
  runCommand?: CommandRunner;
}

export function createModelRegistryCompleteSimple(modelRegistry: BtwCompletionRegistry): CompleteSimpleFunction {
  const completeSimple: CompleteSimpleFunction = async (model, context, options) =>
    modelRegistry.streamSimple(model, context, options).result();
  completeSimple.appliesRequestHeaderTransforms = true;
  return completeSimple;
}

export default function btw(pi: ExtensionAPI, dependencies: BtwExtensionDependencies = {}) {
  const readSettings = dependencies.readSettings ?? (() => readBtwSettings());
  const runFullscreen = dependencies.runFullscreen ?? runBtwFullscreen;
  const createCompleteSimple = dependencies.createCompleteSimple ?? createModelRegistryCompleteSimple;
  const runCommand = dependencies.runCommand ?? createCommandRunner();
  const activity = trackMainAgent(pi);
  const liveFacts = new WeakMap<SideThread, LiveFactsCache>();
  let thread = createSideThread();
  const persist = () => pi.appendEntry(BTW_THREAD_ENTRY_TYPE, serializeThread(thread.turns));

  pi.on("session_start", (_event, ctx) => {
    thread = createSideThread(restoreThreadTurns(ctx.sessionManager.getBranch()));
  });

  pi.registerCommand("btw", {
    description: "Ask a side question about the main agent without adding it to the conversation",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/btw requires interactive TUI mode", "error");
        return;
      }
      let initialQuestion = args.trim();
      if (/^new(?:\s|$)/u.test(initialQuestion)) {
        initialQuestion = initialQuestion.slice(3).trim();
        const hadTurns = thread.turns.length > 0;
        thread = createSideThread();
        if (hadTurns) persist();
      }

      const { settings, warnings } = await readSettings();
      for (const warning of warnings) notifySafely(ctx, warning, "warning");
      const model = resolveBtwModel({
        settings,
        currentModel: ctx.model,
        modelRegistry: ctx.modelRegistry,
        warn: (message) => notifySafely(ctx, message, "warning"),
      });
      if (!model) {
        notifySafely(ctx, "No available model for /btw", "error");
        return;
      }
      const modelLabel = `${model.provider}/${model.id}`;
      const thinkingLevels = getSupportedThinkingLevels(model) as BtwThinkingLevel[];
      const startLevel = settings.thinkingLevel === "main" ? (pi.getThinkingLevel() as BtwThinkingLevel) : settings.thinkingLevel;
      const current: SideThread = thread;
      // The thread keeps a level only once you change it; until then the settings decide.
      const thinkingLevel = () => clampThinkingLevel(model, current.thinkingLevel ?? startLevel) as BtwThinkingLevel;
      const completeSimple = createCompleteSimple(ctx.modelRegistry);

      // Steering opens pi's editor, which needs pi's screen; cancelling it comes back here.
      let pending = initialQuestion;
      let draft = "";
      for (;;) {
        const result = await runFullscreen<BtwWorkspaceResult>(ctx, (screen, theme, keybindings, done) => {
          let request: AbortController | undefined;
          const answer = async (question: string, signal: AbortSignal) => {
            // Rebuilt for every question, so a follow-up sees the current state.
            const branch = ctx.sessionManager.getBranch();
            let facts: string | undefined;
            if (settings.liveFacts) {
              const cache = liveFacts.get(current) ?? new LiveFactsCache();
              liveFacts.set(current, cache);
              const key = [ctx.cwd, ...recentDirectories(branch)].join("\n");
              facts = await cache.get(key, Date.now(), () => collectLiveFacts({ cwd: ctx.cwd, branch, run: runCommand }));
              if (signal.aborted) return { kind: "aborted" as const };
              view.setStatus("Answering…");
            }
            // Read again for every question: prompt files change during long goals.
            const promptPath = objectiveFilePath(branch);
            const promptFile = promptPath ? await readPromptFile(promptPath, ctx.cwd) : undefined;
            if (signal.aborted) return { kind: "aborted" as const };
            const prompt = buildSideContext({
              branch,
              question,
              turns: current.turns,
              activity,
              idle: ctx.isIdle(),
              liveFacts: facts,
              promptFile,
            });
            return completeSideTurn({
              model,
              prompt,
              thinkingLevel: thinkingLevel(),
              routingSessionId: current.routingSessionId,
              signal,
              completeSimple,
              sessionId: readBtwSessionId(ctx),
            });
          };
          const ask = async (question: string) => {
            request = new AbortController();
            const { signal } = request;
            view.startAnswer(question, settings.liveFacts ? "collecting repository facts…" : "Answering…");
            const outcome = await answer(question, signal).catch((error: unknown) => ({
              kind: "error" as const,
              message: error instanceof Error ? error.message : String(error),
            }));
            if (outcome.kind === "aborted" || signal.aborted) return;
            current.turns.push({
              question,
              answer: outcome.kind === "answered" ? outcome.answer : outcome.message,
              at: Date.now(),
              model: modelLabel,
              ...(outcome.kind === "error" ? { error: true as const } : {}),
            });
            current.turns.splice(0, Math.max(0, current.turns.length - MAX_THREAD_TURNS));
            if (current === thread) persist();
            view.finishAnswer();
          };
          const view = new BtwWorkspaceView(screen, theme, {
            turns: current.turns,
            model: modelLabel,
            thinkingLevel: thinkingLevel(),
            thinkingLevels,
            shortcuts: createBtwShortcuts(keybindings),
            draft,
            handlers: {
              submit: (question) => void ask(question),
              cycleThinking: (level) => {
                current.thinkingLevel = level;
              },
              bringBack: () => done({ kind: "bringBack" }),
              steer: (text) => done({ kind: "steer", draft: text }),
              exit: () => {
                if (request && !request.signal.aborted && view.answering) notifySafely(ctx, "Cancelled", "info");
                request?.abort();
                done({ kind: "closed" });
              },
            },
          });
          if (pending) void ask(pending);
          return view;
        });
        pending = "";
        const latest = current.turns.filter((turn) => !turn.error).at(-1);
        if (result?.kind === "bringBack" && latest) {
          const block = formatBtwBringToMain(latest.question, latest.answer);
          ctx.ui.setEditorText(appendToDraft(ctx.ui.getEditorText(), block));
          const lines = block.split("\n").length;
          notifySafely(ctx, `Brought back the latest answer (${lines} ${lines === 1 ? "line" : "lines"})`, "info");
        }
        if (result?.kind !== "steer") return;
        const message = await ctx.ui.editor("Steer the main agent", result.draft.trim() ? result.draft : (latest?.answer ?? ""));
        if (message?.trim()) {
          if (ctx.isIdle()) pi.sendUserMessage(message);
          else pi.sendUserMessage(message, { deliverAs: "steer" });
          notifySafely(ctx, "Sent to the main agent", "info");
          return;
        }
        draft = result.draft;
      }
    },
  });
}

interface ResolveBtwModelOptions {
  settings: Pick<BtwSettings, "model">;
  currentModel: Model<Api> | undefined;
  modelRegistry: BtwModelRegistry;
  warn?: (message: string) => void;
}

/** The configured model when it is available, otherwise the main session's model. */
export function resolveBtwModel({ settings, currentModel, modelRegistry, warn }: ResolveBtwModelOptions): Model<Api> | undefined {
  const availableModels = modelRegistry.getAvailable();
  const isAvailable = (model: Model<Api>): boolean =>
    availableModels.some((candidate) => candidate.provider === model.provider && candidate.id === model.id);
  const current = currentModel && isAvailable(currentModel) ? currentModel : undefined;
  if (!settings.model) return current;

  const fallback = currentModel ? `${currentModel.provider}/${currentModel.id}` : "the current model";
  const reference = parseBtwModelReference(settings.model);
  const configured = reference ? modelRegistry.find(reference.provider, reference.modelId) : undefined;
  if (configured && isAvailable(configured)) return configured;
  const problem = !reference ? "is invalid" : !configured ? "was not found" : "is unavailable";
  warn?.(sanitizeSingleLine(`pi-btw model ${settings.model} ${problem}; falling back to ${fallback}.`));
  return current;
}

function readBtwSessionId(ctx: ExtensionCommandContext): string | undefined {
  const getSessionId = ctx.sessionManager.getSessionId;
  if (typeof getSessionId !== "function") return undefined;
  const sessionId = getSessionId.call(ctx.sessionManager);
  return sessionId.length > 0 ? sessionId : undefined;
}

function notifySafely(
  ctx: ExtensionCommandContext,
  message: string,
  level: Parameters<ExtensionCommandContext["ui"]["notify"]>[1],
): void {
  try {
    ctx.ui.notify(sanitizeSingleLine(message), level);
  } catch {
    // Async command continuations may finish after their ExtensionContext is replaced.
  }
}
