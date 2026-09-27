import { randomUUID } from "node:crypto";
import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  ModelsSimpleStreamOptions,
  ProviderHeaders,
} from "@earendil-works/pi-ai";
import type { BtwThinkingLevel } from "./settings.js";

export const BTW_THREAD_ENTRY_TYPE = "btw-thread";
export const MAX_THREAD_TURNS = 30;
export const MAX_ANSWER_CHARS = 20_000;
const MAX_QUESTION_CHARS = 20_000;

export interface CompleteSimpleFunction {
  <TApi extends Api>(
    model: Model<TApi>,
    context: Context,
    options?: ModelsSimpleStreamOptions,
  ): Promise<AssistantMessage>;
  /** True when the callback applies Models-only header transforms after request-time authentication. */
  appliesRequestHeaderTransforms?: boolean;
}

export interface BtwTurn {
  question: string;
  /** The answer, or the error message when `error` is set. */
  answer: string;
  /** Epoch milliseconds when the turn finished. */
  at: number;
  /** `provider/model-id` that answered. */
  model: string;
  error?: true;
}

/** The session's one side thread. */
export interface SideThread {
  turns: BtwTurn[];
  /**
   * Provider routing ID (`options.sessionId`) shared by this thread's requests.
   * Kept separate from the main pi session so side requests never share its cache or affinity lane.
   */
  routingSessionId: string;
  /** Thinking level chosen in this thread; reset by `/btw new` and `/reload`. */
  thinkingLevel?: BtwThinkingLevel;
}

export interface BtwThreadEntryData {
  turns: BtwTurn[];
}

export function createSideThread(turns: BtwTurn[] = []): SideThread {
  return { turns, routingSessionId: randomUUID() };
}

/** The snapshot appended as a `btw-thread` custom entry: the newest turns, answers capped. */
export function serializeThread(turns: readonly BtwTurn[]): BtwThreadEntryData {
  return {
    turns: turns.slice(-MAX_THREAD_TURNS).map((turn) => ({
      ...turn,
      answer: turn.answer.slice(0, MAX_ANSWER_CHARS),
    })),
  };
}

/** Turns from the latest `btw-thread` entry on the branch; anything malformed is skipped. */
export function restoreThreadTurns(entries: readonly unknown[]): BtwTurn[] {
  let latest: unknown;
  for (const entry of entries) {
    if (isRecord(entry) && entry.type === "custom" && entry.customType === BTW_THREAD_ENTRY_TYPE) latest = entry.data;
  }
  if (!isRecord(latest) || !Array.isArray(latest.turns)) return [];
  const turns: BtwTurn[] = [];
  for (const turn of latest.turns) {
    if (!isRecord(turn) || typeof turn.question !== "string" || typeof turn.answer !== "string") continue;
    turns.push({
      question: turn.question.slice(0, MAX_QUESTION_CHARS),
      answer: turn.answer.slice(0, MAX_ANSWER_CHARS),
      at: typeof turn.at === "number" && Number.isFinite(turn.at) ? turn.at : 0,
      model: typeof turn.model === "string" ? turn.model : "",
      ...(turn.error === true ? { error: true as const } : {}),
    });
  }
  return turns.slice(-MAX_THREAD_TURNS);
}

export interface CompleteSideTurnOptions {
  model: Model<Api>;
  /** The whole request: context sections and the question. */
  prompt: string;
  thinkingLevel: BtwThinkingLevel;
  routingSessionId: string;
  signal?: AbortSignal;
  completeSimple: CompleteSimpleFunction;
  /** Main pi session ID, used only for OpenCode attribution headers. */
  sessionId?: string;
}

export type CompleteSideTurnResult = { kind: "answered"; answer: string } | { kind: "aborted" } | { kind: "error"; message: string };

/** One tool-less request with its own system prompt: a single user message. */
export async function completeSideTurn({
  model,
  prompt,
  thinkingLevel,
  routingSessionId,
  signal,
  completeSimple,
  sessionId,
}: CompleteSideTurnOptions): Promise<CompleteSideTurnResult> {
  if (signal?.aborted) return { kind: "aborted" };
  try {
    const response = await completeSimple(
      model,
      { systemPrompt: SYSTEM_PROMPT, messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] },
      buildStreamOptions(
        { thinkingLevel, signal, model, sessionId, routingSessionId },
        completeSimple.appliesRequestHeaderTransforms === true,
      ),
    );
    if (signal?.aborted || response?.stopReason === "aborted") return { kind: "aborted" };
    if (!isAssistantMessage(response)) return { kind: "error", message: "The side model returned a malformed response." };
    if (response.stopReason === "error") {
      return { kind: "error", message: response.errorMessage ?? "The side model returned an error." };
    }
    return { kind: "answered", answer: extractAssistantText(response) || "No response received." };
  } catch (error: unknown) {
    if (signal?.aborted) return { kind: "aborted" };
    return { kind: "error", message: error instanceof Error ? error.message : String(error) };
  }
}

export function extractAssistantText(response: AssistantMessage): string {
  return response.content
    .filter(
      (content): content is { type: "text"; text: string } =>
        content !== null && typeof content === "object" && content.type === "text" && typeof content.text === "string",
    )
    .map((content) => content.text)
    .join("\n")
    .trim();
}

function isAssistantMessage(value: unknown): value is AssistantMessage {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<AssistantMessage>;
  return candidate.role === "assistant" && Array.isArray(candidate.content) && typeof candidate.stopReason === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Minimal session-header mirror of Pi core provider attribution.
// Core does not export this helper and extensions have no SettingsManager, so only session
// headers are mirrored here. Default attribution headers are intentionally out of scope.
// Request-time auth can replace a custom provider's base URL after these options are built,
// so only canonical provider IDs are safe attribution signals.
function getOpencodeSessionHeaders(
  model: Pick<Model<Api>, "provider">,
  sessionId?: string,
): ProviderHeaders | undefined {
  if (!sessionId || (model.provider !== "opencode" && model.provider !== "opencode-go")) return undefined;
  return { "x-opencode-session": sessionId, "x-opencode-client": "pi" };
}

interface BuildSideThreadStreamOptions {
  thinkingLevel: BtwThinkingLevel;
  signal?: AbortSignal;
  model: Pick<Model<Api>, "provider">;
  sessionId?: string;
  /** Side-request routing ID sent as `options.sessionId`; never the main session ID. */
  routingSessionId: string;
}

function buildStreamOptions(
  { thinkingLevel, signal, model, sessionId, routingSessionId }: BuildSideThreadStreamOptions,
  applyRequestHeaderTransforms: boolean,
): ModelsSimpleStreamOptions {
  const sessionHeaders = getOpencodeSessionHeaders(model, sessionId);
  const options: ModelsSimpleStreamOptions = {
    headers: applyRequestHeaderTransforms ? undefined : sessionHeaders,
    signal,
    // Pi documents sessionId as optional, but providers use it for request routing and
    // some provider overrides require it. Pi core also mints a fresh ID for one-off requests.
    sessionId: routingSessionId,
  };
  if (applyRequestHeaderTransforms && sessionHeaders) {
    // Bug-compatible with core mergeProviderAttributionHeaders: case-sensitive assign, request headers win.
    options.transformHeaders = (headers) => ({ ...sessionHeaders, ...headers });
  }
  if (thinkingLevel !== "off") options.reasoning = thinkingLevel;
  return options;
}

export const SYSTEM_PROMPT = `You answer side questions from a user who is supervising a coding agent (the "main agent"). You cannot see the main conversation or the repository directly.

The user message holds context sections that the pi-btw extension collected just now, each with timestamps: the objective and the goal's progress notes, earlier work (a compaction summary), earlier side questions in this thread, what the main agent is doing right now, a timeline of its recent activity with tool results, and live repository facts from git and GitHub. The question comes last, in <side_question>.

- Answer the question directly and concisely.
- For progress questions ("how close are we?", "why is it taking so long?"), answer from the objective, the progress notes, the tool running now and how long it has run, and the recent results, and say what remains.
- The Objective may include the goal's prompt file. The remaining work is whatever it asks for that the progress notes and recent activity don't show as done.
- Say plainly when something cannot be told from the context, and what would tell it. The sections are cut to fit, so older work may be missing.
- Never claim to have run a command, read a file or changed anything: you have no tools.`;
