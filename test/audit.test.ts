/**
 * Opt-in measurement against real sessions; commits no session content.
 *
 *   BTW_AUDIT=1 npx vitest run test/audit.test.ts
 *
 * Takes the newest 30 session files under $BTW_AUDIT_SESSIONS (default ~/.pi/agent/sessions)
 * that contain a goal-state entry, cuts each at 25/50/75/100% of its lines, and builds both
 * upstream's 40,000-character context and this package's context at every point. The report
 * goes to $BTW_AUDIT_REPORT (default /tmp/pi-btw-fork/audit.md). Next to it go the system
 * prompt and two questions two minutes apart on the newest session, for
 * test/fixtures/measure-bridge-cache.mjs.
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "vitest";
import { buildSideContext, messageText } from "../src/context.js";
import { SYSTEM_PROMPT } from "../src/side-thread.js";

const SESSIONS = process.env.BTW_AUDIT_SESSIONS ?? join(homedir(), ".pi", "agent", "sessions");
const REPORT = process.env.BTW_AUDIT_REPORT ?? "/tmp/pi-btw-fork/audit.md";
const QUESTION = "how close are we to being done?";

type Entry = Record<string, unknown> & { id?: string; parentId?: string | null; timestamp?: string };

function sessionFiles(): string[] {
  const files: string[] = [];
  const walk = (directory: string) => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith(".jsonl") && readFileSync(path, "utf8").includes('"customType":"goal-state"')) files.push(path);
    }
  };
  walk(SESSIONS);
  return files.sort((first, second) => statSync(second).mtimeMs - statSync(first).mtimeMs).slice(0, 30);
}

/** The root-to-entry path, as `sessionManager.getBranch()` returns it. */
function branchAt(entries: readonly Entry[], leaf: Entry): Entry[] {
  const byId = new Map(entries.filter((entry) => entry.id).map((entry) => [entry.id, entry]));
  const path: Entry[] = [];
  for (let entry: Entry | undefined = leaf; entry; entry = entry.parentId ? byId.get(entry.parentId) : undefined) path.unshift(entry);
  return path;
}

/** Upstream 0.61.1 `buildConversationContext`, instrumented with each section's time. */
function upstreamContext(entries: readonly Entry[]) {
  const sections: Array<{ text: string; at: number; args: number }> = [];
  for (const entry of entries) {
    const message = entry.message as { role?: string; content?: unknown; stopReason?: string } | undefined;
    if (entry.type !== "message" || (message?.role !== "user" && message?.role !== "assistant")) continue;
    const lines: string[] = [];
    let args = 0;
    const content = message.content;
    if (typeof content === "string" && content.trim()) lines.push(content.trim());
    for (const block of Array.isArray(content) ? content : []) {
      if (block?.type === "text" && typeof block.text === "string") lines.push(block.text.trim());
      else if (block?.type === "toolCall" && typeof block.name === "string") {
        const json = JSON.stringify(block.arguments) ?? "";
        args += json.length;
        lines.push(`Tool call: ${block.name}(${json})`);
      }
    }
    if (lines.filter(Boolean).length === 0) continue;
    const status = message.stopReason && message.stopReason !== "stop" ? ` (${message.stopReason})` : "";
    sections.push({ text: `${message.role === "user" ? "User" : "Assistant"}${status}: ${lines.filter(Boolean).join("\n")}`, at: Date.parse(String(entry.timestamp)), args });
  }
  const full = sections.map((section) => section.text).join("\n\n");
  const kept: typeof sections = [];
  let length = 0;
  for (const section of [...sections].reverse()) {
    if (length >= 40_000) break;
    kept.unshift(section);
    length += section.text.length + 2;
  }
  const text = full.length <= 40_000 ? full : full.slice(-40_000);
  const firstKept = kept[0];
  const argsShare = kept.reduce((total, section) => total + section.args, 0) / Math.max(1, text.length);
  return { text, since: firstKept?.at ?? 0, span: firstKept ? (kept.at(-1)?.at ?? 0) - firstKept.at : 0, argsShare: Math.min(1, argsShare) };
}

function newMetrics(context: string) {
  const recent = context.slice(context.indexOf("## Recent activity"), context.search(/\n\n(## Live repository facts|<side_question>)/u));
  let args = 0;
  let span = 0;
  let previous: number | undefined;
  for (const line of recent.split("\n")) {
    const match = /^\[(\d\d):(\d\d):(\d\d)\] (.*)$/u.exec(line);
    if (!match) continue;
    const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
    if (previous !== undefined) span += (seconds - previous + 86_400) % 86_400;
    previous = seconds;
    const rest = match[4] ?? "";
    if (!/^(User|Agent):/u.test(rest)) args += Math.max(0, rest.length - rest.indexOf(" ") - 1);
  }
  return { args: args / context.length, results: (recent.match(/^ {2}→ /gmu) ?? []).length, span: span * 1000 };
}

const median = (values: number[]) => {
  const sorted = [...values].sort((first, second) => first - second);
  return sorted.length === 0 ? 0 : (sorted[Math.floor((sorted.length - 1) / 2)]! + sorted[Math.ceil((sorted.length - 1) / 2)]!) / 2;
};
const percentile = (values: number[], p: number) => [...values].sort((first, second) => first - second)[Math.floor((values.length - 1) * p)] ?? 0;
const minutes = (ms: number) => `${(ms / 60_000).toFixed(1)} min`;

test.runIf(process.env.BTW_AUDIT === "1")("measure the context builder against the newest 30 goal sessions", { timeout: 600_000 }, () => {
  const rows: Array<Record<string, number | boolean>> = [];
  const files = sessionFiles();
  for (const file of files) {
    const lines = readFileSync(file, "utf8").trim().split("\n");
    const entries = lines.map((line) => JSON.parse(line) as Entry).filter((entry) => entry.type !== "session");
    for (const fraction of [0.25, 0.5, 0.75, 1]) {
      const cut = entries.slice(0, Math.max(1, Math.floor(lines.length * fraction) - 1));
      const leaf = cut.at(-1);
      if (!leaf) continue;
      const branch = branchAt(cut, leaf);
      const now = Date.parse(String(leaf.timestamp)) || Date.now();
      const context = buildSideContext({ branch, question: QUESTION, now });
      const old = upstreamContext(branch);
      const goalText = [...branch].reverse().map((entry) => ((entry.data as { goal?: { text?: unknown } })?.goal?.text)).find((text) => typeof text === "string") as string | undefined;
      const firstUser = branch.find((entry) => entry.type === "message" && (entry.message as { role?: string })?.role === "user");
      const firstPrompt = firstUser ? messageText((firstUser.message as { content?: unknown }).content).trim() : "";
      const objective = (goalText ?? firstPrompt).trim().slice(0, 60);
      const metrics = newMetrics(context);
      const results = branch.filter((entry) => (entry.message as { role?: string })?.role === "toolResult");
      const toolResults = results.length;
      const oldWindowResults = results.filter((entry) => Date.parse(String(entry.timestamp)) >= old.since).length;
      rows.push({
        newObjective: objective.length > 0 && context.includes(objective),
        oldObjective: firstPrompt.length > 0 && old.text.includes(firstPrompt.slice(0, 60)),
        newArgs: metrics.args,
        oldArgs: old.argsShare,
        newResults: metrics.results,
        toolResults,
        oldWindowResults,
        newSpan: metrics.span,
        oldSpan: old.span,
        newLength: context.length,
        oldLength: old.text.length,
      });
    }
  }
  const count = (key: string) => rows.filter((row) => row[key] === true).length;
  const numbers = (key: string) => rows.map((row) => Number(row[key]));
  const report = [
    `# pi-btw context audit (${new Date().toISOString()})`,
    "",
    `${files.length} session files, ${rows.length} points (25/50/75/100% of lines), question: "${QUESTION}".`,
    "",
    "| Measure | Upstream 0.61.1 | pi-btw |",
    "|---|---|---|",
    `| Objective present | ${count("oldObjective")} of ${rows.length} | ${count("newObjective")} of ${rows.length} |`,
    `| Tool-call arguments, share of context (median) | ${(median(numbers("oldArgs")) * 100).toFixed(1)}% | ${(median(numbers("newArgs")) * 100).toFixed(1)}% |`,
    `| Tool results represented (median per point) | 0 (${median(numbers("oldWindowResults"))} dropped inside its window) | ${median(numbers("newResults"))} (of ${median(numbers("toolResults"))} on the branch) |`,
    `| Time span of recent activity (median / p10) | ${minutes(median(numbers("oldSpan")))} / ${minutes(percentile(numbers("oldSpan"), 0.1))} | ${minutes(median(numbers("newSpan")))} / ${minutes(percentile(numbers("newSpan"), 0.1))} |`,
    `| Largest context (characters) | ${Math.max(...numbers("oldLength"))} | ${Math.max(...numbers("newLength"))} |`,
    "",
  ].join("\n");
  mkdirSync(dirname(REPORT), { recursive: true });
  writeFileSync(REPORT, report);
  const newest = readFileSync(files[0] ?? "", "utf8").trim().split("\n").map((line) => JSON.parse(line) as Entry).filter((entry) => entry.type !== "session");
  const leaf = newest.at(-1);
  if (leaf) {
    const branch = branchAt(newest, leaf);
    const now = Date.parse(String(leaf.timestamp)) || Date.now();
    const first = { question: QUESTION, answer: "(the first answer)", at: now + 30_000, model: "m" };
    writeFileSync(join(dirname(REPORT), "system.txt"), SYSTEM_PROMPT);
    writeFileSync(join(dirname(REPORT), "question-1.txt"), buildSideContext({ branch, question: QUESTION, now }));
    writeFileSync(join(dirname(REPORT), "question-2.txt"), buildSideContext({ branch, question: "and how long will that take?", turns: [first], now: now + 120_000 }));
  }
  console.log(report);
});
