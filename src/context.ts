import type { MainAgentActivity } from "./activity.js";
import type { BtwTurn } from "./side-thread.js";

/** The whole request: context sections plus the question. */
export const CONTEXT_BUDGET = 60_000;
const OBJECTIVE_CHARS = 4_000;
const EARLIER_WORK_CHARS = 8_000;
const SIDE_QUESTIONS_CHARS = 15_000;
const MAIN_AGENT_CHARS = 2_000;
const LIVE_FACTS_CHARS = 8_000;
const QUESTION_CHARS = 8_000;
const PROGRESS_NOTES = 5;
const USER_CHARS = 1_500;
const PROSE_CHARS = 2_000;
const REASONING_CHARS = 400;
export const TOOL_ARGS_CHARS = 200;
const RESULT_CHARS = 800;
const RESULT_KEY_LINES = 8;
const RESULT_TAIL_LINES = 5;
const KEY_LINE =
  /test result:|\b\d+ (?:passed|failed|failing|skipped|ignored|errors?)\b|\btests?:?\s+\d+|\berror\b|\bfailed\b|^failures:|\bpanicked\b|warning:/iu;
const BASH_EXIT = /(?:^|\n)Command exited with code (-?\d+)\s*$/u;

export interface SideContextInput {
  /** `ctx.sessionManager.getBranch()`, read again for every question. */
  branch: readonly unknown[];
  question: string;
  /** Earlier turns of the side thread, oldest first. */
  turns?: readonly BtwTurn[];
  activity?: MainAgentActivity;
  /** `ctx.isIdle()`; wins over the tracked state. */
  idle?: boolean;
  /** Section 6, already formatted. */
  liveFacts?: string;
  now?: number;
}

/**
 * Sections that change least come first and the question comes last, so repeated
 * questions share a prefix. Sections 1, 2, 4 and 6 have their own caps and are always
 * kept; section 3 keeps its newest turns; recent activity fills what remains.
 */
export function buildSideContext(input: SideContextInput): string {
  const now = input.now ?? Date.now();
  const branch = input.branch.filter(isRecord);
  const goal = findGoal(branch);
  const compaction = branch.filter((entry) => entry.type === "compaction" && typeof entry.summary === "string").at(-1);
  const before = [
    section("Objective", objectiveBody(branch, goal), OBJECTIVE_CHARS),
    compaction ? section("Earlier work", `Compaction summary from ${clock(entryTime(compaction))}:\n${compaction.summary}`, EARLIER_WORK_CHARS) : undefined,
    sideQuestionsSection(input.turns ?? []),
    section("Main agent now", mainAgentBody(branch, goal, input, now), MAIN_AGENT_CHARS),
  ].filter((part): part is string => part !== undefined);
  const after = [
    input.liveFacts ? section("Live repository facts", input.liveFacts, LIVE_FACTS_CHARS) : undefined,
    `<side_question>\n${clip(input.question, QUESTION_CHARS)}\n</side_question>`,
  ].filter((part): part is string => part !== undefined);
  const fixedLength = [...before, ...after].reduce((total, part) => total + part.length + 2, 0);
  const recent = recentActivitySection(branch, input.activity, CONTEXT_BUDGET - fixedLength - 2);
  return [...before, ...(recent ? [recent] : []), ...after].join("\n\n");
}

function section(title: string, body: string, cap: number): string {
  const heading = `## ${title}\n`;
  return heading + clip(body, cap - heading.length);
}

// ── 1. Objective ────────────────────────────────────────────────────────────

interface GoalState {
  goal: Record<string, unknown>;
  text?: string;
}

/** The latest pi-goal state with a goal; a long objective is stored only in an earlier entry for its id. */
function findGoal(branch: readonly Record<string, unknown>[]): GoalState | undefined {
  const objectives = new Map<string, string>();
  let latest: Record<string, unknown> | undefined;
  for (const entry of branch) {
    if (entry.type !== "custom" || entry.customType !== "goal-state" || !isRecord(entry.data)) continue;
    const goal = entry.data.goal;
    if (!isRecord(goal)) continue;
    if (typeof goal.id === "string" && typeof goal.text === "string") objectives.set(goal.id, goal.text);
    latest = goal;
  }
  if (!latest) return undefined;
  const text = typeof latest.text === "string" ? latest.text : typeof latest.id === "string" ? objectives.get(latest.id) : undefined;
  return { goal: latest, text };
}

/** Nothing here depends on the clock; active time and ages are in "Main agent now". */
function objectiveBody(branch: readonly Record<string, unknown>[], state: GoalState | undefined): string {
  if (!state) {
    const first = branch.find((entry) => entry.type === "message" && isRecord(entry.message) && entry.message.role === "user");
    const text = first ? messageText((first.message as Record<string, unknown>).content) : "";
    return text.trim() ? `First user message (no pi-goal goal on this branch):\n${text.trim()}` : "No objective found on this branch.";
  }
  const { goal } = state;
  const status = [
    `pi-goal status: ${oneLine(clip(str(goal.status) ?? "unknown", 40))}`,
    str(goal.pauseReason) ? `paused (${oneLine(clip(str(goal.pauseReason) ?? "", 40))})` : undefined,
    str(goal.stopDetail) ? `detail: ${oneLine(clip(str(goal.stopDetail) ?? "", 300))}` : undefined,
  ].filter(Boolean);
  const head = [status.join(" · ")];
  const path = isRecord(goal.objectiveFile) ? str(goal.objectiveFile.path) : undefined;
  if (path) head.push(`Prompt file: ${clip(path, 300)} (its contents are not included)`);
  const notes = (Array.isArray(goal.progress) ? goal.progress : [])
    .filter((note): note is { at: number; note: string } => isRecord(note) && typeof note.note === "string" && finite(note.at))
    .slice(-PROGRESS_NOTES)
    .map((note) => `- ${clock(note.at)}: ${oneLine(clip(note.note, 300))}`);
  const tail = notes.length > 0 ? ["Progress notes, newest last:", ...notes] : ["No progress notes yet."];
  const room = OBJECTIVE_CHARS - 40 - [...head, ...tail].join("\n").length;
  const text = state.text?.trim() ? clip(state.text.trim(), Math.max(200, room)) : "(objective text not found)";
  return [...head, "Objective:", text, ...tail].join("\n");
}

function activeSeconds(goal: Record<string, unknown>, now: number): number {
  const used = finite(goal.timeUsedSeconds) ? Math.max(0, goal.timeUsedSeconds) : 0;
  const running = goal.status === "active" && finite(goal.activeStartedAt) ? Math.max(0, now - goal.activeStartedAt) / 1000 : 0;
  return used + running;
}

// ── 3. Earlier side questions ───────────────────────────────────────────────

function sideQuestionsSection(turns: readonly BtwTurn[]): string | undefined {
  const heading = "## Earlier side questions\n";
  const kept: string[] = [];
  let room = SIDE_QUESTIONS_CHARS - heading.length;
  for (const turn of [...turns].reverse()) {
    if (turn.error) continue;
    const question = `[${clock(turn.at)}] Q: ${clip(turn.question, 2_000)}\nA: `;
    // Only the newest answer is cut to fit; older turns are kept whole or dropped.
    const answer = kept.length === 0 ? clip(turn.answer, Math.max(0, room - question.length - 1)) : turn.answer;
    const block = question + answer;
    if (block.length + 1 > room) break;
    kept.unshift(block);
    room -= block.length + 1;
  }
  return kept.length > 0 ? heading + kept.join("\n") : undefined;
}

// ── 4. Main agent now ───────────────────────────────────────────────────────

function mainAgentBody(
  branch: readonly Record<string, unknown>[],
  state: GoalState | undefined,
  { activity, idle }: SideContextInput,
  now: number,
): string {
  const lines = [`Collected by pi-btw at ${clock(now)}.`];
  const running = idle === undefined ? (activity?.running ?? false) : !idle;
  const since = (at: number | undefined) => (at === undefined ? "" : ` since ${clock(at)} (${duration((now - at) / 1000)})`);
  lines.push(running ? `Status: running${since(activity?.runStartedAt)}` : "Status: idle");
  for (const tool of activity?.tools.values() ?? []) {
    lines.push(`Running now: ${formatToolCall(tool.name, tool.args)} running for ${duration((now - tool.startedAt) / 1000)}`);
  }
  const lastEntry = branch.map(entryTime).filter((at): at is number => at !== undefined).at(-1);
  if (activity?.lastActivityAt !== undefined) {
    lines.push(`Last activity: ${activity.lastActivity ?? "event"} ${duration((now - activity.lastActivityAt) / 1000)} ago`);
  } else if (lastEntry !== undefined) {
    lines.push(`Last session entry: ${clock(lastEntry)} (${duration((now - lastEntry) / 1000)} ago)`);
  }
  if (state) {
    const latestNote = (Array.isArray(state.goal.progress) ? state.goal.progress : [])
      .map((note) => (isRecord(note) && finite(note.at) ? note.at : undefined))
      .filter((at): at is number => at !== undefined)
      .at(-1);
    const noteAge = latestNote === undefined ? "" : `; latest progress note ${duration((now - latestNote) / 1000)} ago`;
    lines.push(`Goal active time: ${duration(activeSeconds(state.goal, now))}${noteAge}`);
  }
  const waiting = state?.goal.status === "active" && isRecord(state.goal.waiting) ? state.goal.waiting : undefined;
  if (waiting) {
    const wake = isRecord(waiting.wakeWhen) ? waiting.wakeWhen : {};
    const until = [
      str(wake.command) ? `wakes when \`${oneLine(clip(str(wake.command) ?? "", TOOL_ARGS_CHARS))}\` succeeds` : undefined,
      finite(wake.pid) ? `wakes when process ${wake.pid} exits` : undefined,
      finite(waiting.resumeAt) ? `resumes by ${clock(waiting.resumeAt)}` : undefined,
    ].filter(Boolean);
    lines.push(`Goal waiting: ${oneLine(clip(str(waiting.reason) ?? "", 500))}${until.length > 0 ? ` (${until.join("; ")})` : ""}`);
  }
  return lines.join("\n");
}

// ── 5. Recent activity ──────────────────────────────────────────────────────

function recentActivitySection(
  branch: readonly Record<string, unknown>[],
  activity: MainAgentActivity | undefined,
  budget: number,
): string | undefined {
  const heading = "## Recent activity (newest last)\n";
  const results = new Map<string, { message: Record<string, unknown>; at?: number }>();
  for (const entry of branch) {
    const message = entry.message;
    if (isRecord(message) && message.role === "toolResult" && typeof message.toolCallId === "string") {
      results.set(message.toolCallId, { message, at: entryTime(entry) });
    }
  }
  const items: string[] = [];
  for (const entry of branch) {
    const message = entry.message;
    if (entry.type !== "message" || !isRecord(message)) continue;
    const at = entryTime(entry);
    if (message.role === "user") {
      const text = messageText(message.content).trim();
      if (text) items.push(`[${clock(at)}] User: ${clip(text, USER_CHARS)}`);
    }
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    const blocks = message.content.filter(isRecord);
    const prose = blocks.map((block) => (block.type === "text" ? str(block.text) : undefined)).filter(Boolean).join("\n").trim();
    const reasoning = blocks.map((block) => (block.type === "thinking" ? str(block.thinking) : undefined)).filter(Boolean).join("\n").trim();
    if (prose || reasoning) {
      const lines = [`[${clock(at)}] Agent: ${prose ? clip(prose, PROSE_CHARS) : "(no text)"}`];
      if (reasoning) lines.push(`  reasoning: …${reasoning.slice(-REASONING_CHARS)}`);
      items.push(lines.join("\n"));
    }
    for (const call of blocks.filter((block) => block.type === "toolCall")) {
      const name = str(call.name) ?? "tool";
      const id = str(call.id);
      const result = id ? results.get(id) : undefined;
      const running = id ? activity?.tools.get(id) : undefined;
      const outcome = result
        ? formatToolResult(name, result.message, at, result.at)
        : running
          ? "  → still running"
          : "  → no result recorded";
      items.push(`[${clock(at)}] ${formatToolCall(name, call.arguments)}\n${outcome}`);
    }
  }
  const omittedNote = (count: number) => `[${count} earlier items omitted]\n`;
  let room = budget - heading.length - omittedNote(items.length).length;
  let start = items.length;
  while (start > 0) {
    const cost = (items[start - 1]?.length ?? 0) + 1;
    if (cost > room) break;
    room -= cost;
    start -= 1;
  }
  if (items.length === 0) return undefined;
  if (start === items.length) {
    const note = heading + omittedNote(items.length).trimEnd();
    return note.length <= budget ? note : undefined;
  }
  return heading + (start > 0 ? omittedNote(start) : "") + items.slice(start).join("\n");
}

/** One line per call; arguments never contribute more than 200 characters, and file contents never appear. */
export function formatToolCall(name: string, args: unknown): string {
  const input = isRecord(args) ? args : {};
  const arg = (text: string) => oneLine(clip(text, TOOL_ARGS_CHARS));
  const path = str(input.path) ?? str(input.file_path) ?? "";
  switch (name) {
    case "bash":
      return `bash \`${arg(str(input.command) ?? "")}\``;
    case "read":
      return `read ${arg(path)}`;
    case "ls":
      return `ls ${arg(path || ".")}`;
    case "grep":
    case "find":
      return `${name} ${arg([str(input.pattern), path ? `in ${path}` : undefined].filter(Boolean).join(" "))}`;
    case "edit": {
      const edits = Array.isArray(input.edits) ? input.edits.length : 1;
      return `edit ${arg(path)} (${edits} ${edits === 1 ? "edit" : "edits"})`;
    }
    case "write":
      return `write ${arg(path)} (${(str(input.content) ?? "").length} chars)`;
    default:
      return `${oneLine(clip(name, 80))} ${arg(json(args))}`;
  }
}

function formatToolResult(name: string, message: Record<string, unknown>, calledAt?: number, finishedAt?: number): string {
  const text = messageText(message.content);
  const exit = name === "bash" ? (BASH_EXIT.exec(text)?.[1] ?? (message.isError === true ? undefined : "0")) : undefined;
  const status = [
    message.isError === true ? "error" : "ok",
    exit === undefined ? undefined : `exit ${exit}`,
    calledAt !== undefined && finishedAt !== undefined ? duration((finishedAt - calledAt) / 1000) : undefined,
  ].filter(Boolean);
  let lines: string[] = [];
  if (name === "read" && message.isError !== true) {
    status.push(`${text.split("\n").length} lines`);
  } else {
    const all = text.replace(BASH_EXIT, "").split("\n").map((line) => line.trimEnd()).filter((line) => line.trim());
    const key = all.filter((line) => KEY_LINE.test(line));
    lines = (key.length > 0 ? key.slice(-RESULT_KEY_LINES) : all.slice(-RESULT_TAIL_LINES)).map((line) => `  | ${clip(line, 200)}`);
  }
  return clip([`  → ${status.join(", ")}`, ...lines].join("\n"), RESULT_CHARS);
}

// ── helpers ─────────────────────────────────────────────────────────────────

export function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (isRecord(block) && block.type === "text" && typeof block.text === "string" ? block.text : ""))
    .filter(Boolean)
    .join("\n");
}

/** Keep the head and the tail of long text. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max < 20) return text.slice(0, Math.max(0, max));
  const marker = ` …[${text.length - max} chars cut]… `;
  const room = Math.max(0, max - marker.length);
  const head = Math.ceil((room * 2) / 3);
  return text.slice(0, head) + marker + text.slice(text.length - (room - head));
}

function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/gu, " ⏎ ");
}

function json(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

function entryTime(entry: Record<string, unknown>): number | undefined {
  const parsed = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
  if (Number.isFinite(parsed)) return parsed;
  const message = entry.message;
  return isRecord(message) && finite(message.timestamp) ? message.timestamp : undefined;
}

export function clock(at: number | undefined): string {
  if (at === undefined || !Number.isFinite(at)) return "--:--:--";
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "--:--:--";
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map((part) => String(part).padStart(2, "0")).join(":");
}

export function duration(seconds: number): string {
  const whole = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  if (whole < 60) return `${whole}s`;
  const minutes = Math.floor(whole / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
