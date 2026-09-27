import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { clock, type PromptFileRead } from "./context.js";

const GIT_TIMEOUT_MS = 3_000;
const GH_TIMEOUT_MS = 6_000;
export const LIVE_FACTS_CACHE_MS = 20_000;
const MAX_REPOSITORIES = 2;
const MAX_PROMPT_FILE_BYTES = 1024 * 1024;
const RECENT_TOOL_CALLS = 30;
const CANDIDATE_DIRECTORIES = 6;
const STATUS_LINES = 20;
const IN_PROGRESS = [
  ["rebase-merge", "rebase"],
  ["rebase-apply", "rebase or am"],
  ["MERGE_HEAD", "merge"],
  ["CHERRY_PICK_HEAD", "cherry-pick"],
  ["REVERT_HEAD", "revert"],
] as const;

/** Runs one read-only command; resolves stdout, or undefined on any failure or timeout. */
export type CommandRunner = (command: string, args: readonly string[], cwd: string, timeoutMs: number) => Promise<string | undefined>;

export function createCommandRunner(env: NodeJS.ProcessEnv = process.env): CommandRunner {
  // Keep `git status` from refreshing the index and gh from writing its update-check state.
  const readOnlyEnv = { ...env, GIT_OPTIONAL_LOCKS: "0", GH_NO_UPDATE_NOTIFIER: "1", GH_PROMPT_DISABLED: "1", NO_COLOR: "1" };
  return (command, args, cwd, timeoutMs) =>
    new Promise((resolveOutput) => {
      execFile(command, [...args], { cwd, timeout: timeoutMs, maxBuffer: 1 << 20, env: readOnlyEnv, windowsHide: true }, (error, stdout) =>
        resolveOutput(error ? undefined : stdout),
      );
    });
}

export interface LiveFactsInput {
  cwd: string;
  branch: readonly unknown[];
  run?: CommandRunner;
  now?: number;
}

/** Section 6: git and GitHub facts for the session's repository and the one the agent last worked in. */
export async function collectLiveFacts({ cwd, branch, run = createCommandRunner(), now = Date.now() }: LiveFactsInput): Promise<string | undefined> {
  const toplevel = async (directory: string) =>
    (await run("git", ["-C", directory, "rev-parse", "--show-toplevel"], directory, GIT_TIMEOUT_MS))?.trim() || undefined;
  const [own, ...others] = await Promise.all([toplevel(cwd), ...recentDirectories(branch).map(toplevel)]);
  const repositories: Array<{ path: string; label: string }> = [];
  if (own) repositories.push({ path: own, label: "the session's working directory" });
  const worked = others.find((path) => path && path !== own);
  if (worked) repositories.push({ path: worked, label: "where the main agent last worked" });
  if (repositories.length === 0) return undefined;
  const sections = await Promise.all(repositories.slice(0, MAX_REPOSITORIES).map((repository) => repositoryFacts(repository.path, repository.label, run)));
  return [`Collected by pi-btw at ${clock(now)} with read-only git and gh commands.`, ...sections].join("\n\n");
}

async function repositoryFacts(path: string, label: string, run: CommandRunner): Promise<string> {
  const git = (...args: string[]) => run("git", ["-C", path, ...args], path, GIT_TIMEOUT_MS);
  const [status, log, gitPaths, pr] = await Promise.all([
    git("status", "-sb"),
    git("log", "--oneline", "-5"),
    git("rev-parse", ...IN_PROGRESS.flatMap(([name]) => ["--git-path", name])),
    run("gh", ["pr", "view", "--json", "number,title,state,isDraft,url,statusCheckRollup"], path, GH_TIMEOUT_MS),
  ]);
  const lines = [`### ${path} (${label})`];
  if (status !== undefined) {
    const statusLines = status.trimEnd().split("\n");
    lines.push("$ git status -sb", ...statusLines.slice(0, STATUS_LINES));
    if (statusLines.length > STATUS_LINES) lines.push(`… ${statusLines.length - STATUS_LINES} more lines`);
  }
  if (log?.trim()) lines.push("$ git log --oneline -5", log.trimEnd());
  const operations = (gitPaths?.trim().split("\n") ?? []).flatMap((gitPath, index) => {
    const [name, operation] = IN_PROGRESS[index] ?? [];
    const absolute = resolve(path, gitPath.trim());
    if (!name || !operation || !existsSync(absolute)) return [];
    return [name === "rebase-merge" ? `${operation} (${rebaseDetail(absolute)})` : operation];
  });
  lines.push(operations.length > 0 ? `In progress: ${operations.join(", ")}` : "In progress: no rebase, merge or cherry-pick");
  const summary = pr ? summarizePullRequest(pr) : undefined;
  if (summary) lines.push(summary);
  return lines.join("\n");
}

function rebaseDetail(directory: string): string {
  const read = (name: string) => {
    try {
      return readFileSync(join(directory, name), "utf8").trim();
    } catch {
      return undefined;
    }
  };
  const head = read("head-name")?.replace(/^refs\/heads\//u, "");
  const onto = read("onto")?.slice(0, 12);
  const step = read("msgnum");
  const end = read("end");
  return [head ? `rebasing ${head}` : "rebasing", onto ? `onto ${onto}` : undefined, step && end ? `step ${step} of ${end}` : undefined]
    .filter(Boolean)
    .join(" ");
}

/** e.g. `PR #2502 "Add cassettes" open, draft, checks: 14 passed, 1 failed (clippy), 2 pending — <url>` */
export function summarizePullRequest(json: string): string | undefined {
  let pr: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    pr = parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (typeof pr.number !== "number") return undefined;
  let passed = 0;
  let pending = 0;
  let skipped = 0;
  const failed: string[] = [];
  for (const check of Array.isArray(pr.statusCheckRollup) ? pr.statusCheckRollup : []) {
    if (typeof check !== "object" || check === null) continue;
    const { name, context, status, conclusion, state } = check as Record<string, unknown>;
    const outcome = String(conclusion || state || "").toUpperCase();
    if ((status !== undefined && status !== "COMPLETED") || outcome === "PENDING" || outcome === "EXPECTED" || outcome === "") pending += 1;
    else if (outcome === "SUCCESS" || outcome === "NEUTRAL") passed += 1;
    else if (outcome === "SKIPPED") skipped += 1;
    else failed.push(String(name ?? context ?? "unnamed"));
  }
  const checks = [
    `${passed} passed`,
    failed.length > 0 ? `${failed.length} failed (${failed.slice(0, 5).join(", ")}${failed.length > 5 ? ", …" : ""})` : undefined,
    pending > 0 ? `${pending} pending` : undefined,
    skipped > 0 ? `${skipped} skipped` : undefined,
  ].filter(Boolean);
  const total = passed + failed.length + pending + skipped;
  const title = typeof pr.title === "string" ? ` ${JSON.stringify(pr.title.slice(0, 200))}` : "";
  const state = typeof pr.state === "string" ? pr.state.toLowerCase() : "unknown state";
  return `PR #${pr.number}${title} ${state}${pr.isDraft === true ? ", draft" : ""}, checks: ${total === 0 ? "none" : checks.join(", ")}${typeof pr.url === "string" ? ` — ${pr.url}` : ""}`;
}

/**
 * Directories from the newest tool calls, newest first: `cd` targets and absolute
 * paths, because the main agent often works in a separate worktree.
 */
export function recentDirectories(branch: readonly unknown[]): string[] {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  for (const entry of branch) {
    const message = isRecord(entry) ? entry.message : undefined;
    if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (isRecord(block) && block.type === "toolCall" && typeof block.name === "string") {
        calls.push({ name: block.name, args: isRecord(block.arguments) ? block.arguments : {} });
      }
    }
  }
  const directories: string[] = [];
  for (const { name, args } of calls.slice(-RECENT_TOOL_CALLS).reverse()) {
    const paths = name === "bash" && typeof args.command === "string" ? commandPaths(args.command) : [args.path, args.cwd];
    for (const path of paths) {
      const directory = typeof path === "string" ? existingDirectory(path) : undefined;
      if (directory && !directories.includes(directory)) directories.push(directory);
    }
    if (directories.length >= CANDIDATE_DIRECTORIES) break;
  }
  return directories.slice(0, CANDIDATE_DIRECTORIES);
}

/** `cd` targets first (the last one wins), then other absolute paths, last first. */
function commandPaths(command: string): string[] {
  const unquote = (token: string) => token.replace(/^(["'])(.*)\1$/u, "$2");
  const cds = [...command.matchAll(/(?:^|[;&|(\s])cd\s+("[^"]+"|'[^']+'|[^\s;&|)]+)/gu)].map((match) => unquote(match[1] ?? ""));
  const absolute = [...command.matchAll(/(?:^|[\s=:"'(])((?:~|\/)[^\s;&|)"'`<>]*)/gu)].map((match) => match[1] ?? "");
  return [...cds.reverse(), ...absolute.reverse()];
}

function existingDirectory(path: string): string | undefined {
  let candidate = path.startsWith("~/") || path === "~" ? join(homedir(), path.slice(1)) : path;
  if (!isAbsolute(candidate)) return undefined;
  for (let depth = 0; depth < 64; depth += 1) {
    try {
      if (statSync(candidate).isDirectory()) return candidate === "/" ? undefined : candidate;
    } catch {
      // Not there yet (a file about to be written, say); try its parent.
    }
    const parent = dirname(candidate);
    if (parent === candidate) return undefined;
    candidate = parent;
  }
  return undefined;
}

/**
 * The goal's prompt file as it is now: only the path pi-goal recorded, only a regular
 * UTF-8 text file up to 1 MB. Anything else becomes a one-line reason; nothing throws.
 */
export async function readPromptFile(path: string, cwd: string): Promise<PromptFileRead> {
  const absolute = resolve(cwd, path);
  try {
    const info = await stat(absolute);
    if (!info.isFile()) return { kind: "unreadable", reason: "the prompt file is not a regular file" };
    if (info.size > MAX_PROMPT_FILE_BYTES) return { kind: "unreadable", reason: "the prompt file is larger than 1 MB, so it is not included" };
    const bytes = await readFile(absolute);
    if (bytes.byteLength > MAX_PROMPT_FILE_BYTES) return { kind: "unreadable", reason: "the prompt file is larger than 1 MB, so it is not included" };
    const text = decodeText(bytes);
    if (text === undefined) return { kind: "unreadable", reason: "the prompt file is not UTF-8 text, so it is not included" };
    return { kind: "text", text, sha256: createHash("sha256").update(bytes).digest("hex") };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    return { kind: "unreadable", reason: code === "ENOENT" || code === "ENOTDIR" ? "the prompt file no longer exists" : "the prompt file could not be read" };
  }
}

/** Strict UTF-8 without NUL bytes, or undefined. */
function decodeText(bytes: Uint8Array): string | undefined {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text.includes("\u0000") ? undefined : text;
  } catch {
    return undefined;
  }
}

/** Live facts for one thread, reused for 20 seconds. */
export class LiveFactsCache {
  private cached: { key: string; at: number; facts: string | undefined } | undefined;

  async get(key: string, now: number, collect: () => Promise<string | undefined>): Promise<string | undefined> {
    if (this.cached && this.cached.key === key && now - this.cached.at < LIVE_FACTS_CACHE_MS) return this.cached.facts;
    const facts = await collect();
    this.cached = { key, at: now, facts };
    return facts;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
