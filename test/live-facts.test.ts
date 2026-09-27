import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, test } from "vitest";
import {
  collectLiveFacts,
  createCommandRunner,
  LiveFactsCache,
  recentDirectories,
  summarizePullRequest,
} from "../src/live-facts.js";
import { createBtwHarness, KEYS } from "./support/btw-fixture.js";
import { assistantEntry, minutes, toolCall } from "./support/session-entries.js";

const PR_JSON = JSON.stringify({
  number: 2502,
  title: "Add cassette tests",
  state: "OPEN",
  isDraft: false,
  url: "https://github.com/example/rig/pull/2502",
  statusCheckRollup: [
    ...Array.from({ length: 14 }, (_, index) => ({ __typename: "CheckRun", name: `test-${index}`, status: "COMPLETED", conclusion: "SUCCESS" })),
    { __typename: "CheckRun", name: "clippy", status: "COMPLETED", conclusion: "FAILURE" },
    { __typename: "CheckRun", name: "msrv", status: "IN_PROGRESS", conclusion: "" },
    { __typename: "StatusContext", context: "ci/docs", state: "PENDING" },
  ],
});

let root: string;
let repo: string;
let worktree: string;
let stubs: string;
let ghCalls: string;

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  }).toString();

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pi-btw-facts-")));
  repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q");
  writeFileSync(join(repo, "lib.rs"), "fn a() {}\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "first commit");
  git(repo, "checkout", "-qb", "feature");
  writeFileSync(join(repo, "lib.rs"), "fn feature() {}\n");
  git(repo, "commit", "-qam", "feature change");
  git(repo, "checkout", "-q", "main");
  writeFileSync(join(repo, "lib.rs"), "fn main_change() {}\n");
  git(repo, "commit", "-qam", "main change");
  git(repo, "checkout", "-q", "feature");
  try {
    git(repo, "rebase", "main");
  } catch {
    // The conflict leaves the rebase in progress, which is the point.
  }
  writeFileSync(join(repo, "notes.txt"), "dirty\n");

  worktree = join(root, "other");
  mkdirSync(worktree);
  git(worktree, "init", "-q");
  writeFileSync(join(worktree, "README.md"), "other\n");
  git(worktree, "add", ".");
  git(worktree, "commit", "-qm", "other repo commit");

  stubs = join(root, "bin");
  mkdirSync(stubs);
  ghCalls = join(root, "gh-calls.txt");
  writeFileSync(
    join(stubs, "gh"),
    `#!/bin/sh\necho "$PWD $*" >> "${ghCalls}"\nif [ "$PWD" = "${repo}" ]; then echo '${PR_JSON}'; else echo "no pull requests found" >&2; exit 1; fi\n`,
  );
  chmodSync(join(stubs, "gh"), 0o755);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

test("live facts cover the status, log, a rebase in progress and the PR, read-only", async () => {
  const run = createCommandRunner({ ...process.env, PATH: `${stubs}:${process.env.PATH}` });
  const before = execFileSync("git", ["-C", repo, "status", "--porcelain=v2", "--branch"]).toString();
  const facts = await collectLiveFacts({ cwd: repo, branch: [], run, now: minutes(0) });
  assert.ok(facts);
  assert.match(facts, /^Collected by pi-btw at 12:00:00 with read-only git and gh commands\./u);
  assert.match(facts, new RegExp(`### ${repo} \\(the session's working directory\\)`, "u"));
  assert.match(facts, /\$ git status -sb\n## HEAD \(no branch\)\nUU lib\.rs\n\?\? notes\.txt/u);
  assert.match(facts, /\$ git log --oneline -5\n[0-9a-f]+ main change\n[0-9a-f]+ first commit/u);
  assert.match(facts, /In progress: rebase \(rebasing feature onto [0-9a-f]{12} step 1 of 1\)/u);
  assert.match(
    facts,
    /PR #2502 "Add cassette tests" open, checks: 14 passed, 1 failed \(clippy\), 2 pending — https:\/\/github\.com\/example\/rig\/pull\/2502/u,
  );
  assert.equal(execFileSync("git", ["-C", repo, "status", "--porcelain=v2", "--branch"]).toString(), before);
});

test("the repository the agent last worked in is added, and a missing PR is skipped", async () => {
  const run = createCommandRunner({ ...process.env, PATH: `${stubs}:${process.env.PATH}` });
  const branch = [
    assistantEntry([toolCall("1", "read", { path: join(repo, "lib.rs") })], minutes(0)),
    assistantEntry([toolCall("2", "bash", { command: `cd ${worktree} && cargo test 2>/dev/null` })], minutes(1)),
  ];
  assert.deepEqual(recentDirectories(branch), [worktree, repo]);
  const facts = await collectLiveFacts({ cwd: repo, branch, run });
  assert.match(facts ?? "", new RegExp(`### ${worktree} \\(where the main agent last worked\\)[\\s\\S]*other repo commit\\nIn progress: no rebase, merge or cherry-pick$`, "u"));
  assert.equal((facts ?? "").match(/^### /gmu)?.length, 2);
});

test("outside a repository, and without gh, there are no facts and no errors", async () => {
  const run = createCommandRunner({ ...process.env, PATH: "/usr/bin:/bin" });
  const outside = mkdtempSync(join(tmpdir(), "pi-btw-no-repo-"));
  try {
    assert.equal(await collectLiveFacts({ cwd: outside, branch: [], run }), undefined);
    const facts = await collectLiveFacts({ cwd: worktree, branch: [], run });
    assert.doesNotMatch(facts ?? "", /PR #/u);
    assert.match(facts ?? "", /other repo commit/u);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("git gets 3 seconds and gh 6, all in parallel", async () => {
  const calls: Array<{ command: string; timeout: number; started: number }> = [];
  const run = async (command: string, args: readonly string[], _cwd: string, timeout: number) => {
    calls.push({ command, timeout, started: calls.length });
    await new Promise((resolve) => setTimeout(resolve, 20));
    return args.includes("--show-toplevel") ? "/repo\n" : command === "gh" ? undefined : "";
  };
  const started = Date.now();
  await collectLiveFacts({ cwd: "/repo", branch: [], run });
  assert.ok(Date.now() - started < 200, "commands run in parallel");
  assert.deepEqual(new Set(calls.filter((call) => call.command === "git").map((call) => call.timeout)), new Set([3_000]));
  assert.deepEqual(calls.filter((call) => call.command === "gh").map((call) => call.timeout), [6_000]);
});

test("pull request summaries count passed, failed, pending and skipped checks", () => {
  assert.equal(
    summarizePullRequest(JSON.stringify({ number: 7, state: "MERGED", isDraft: true, statusCheckRollup: [{ status: "COMPLETED", conclusion: "SKIPPED" }] })),
    "PR #7 merged, draft, checks: 0 passed, 1 skipped",
  );
  assert.equal(summarizePullRequest(JSON.stringify({ number: 8, state: "OPEN", statusCheckRollup: [] })), "PR #8 open, checks: none");
  assert.equal(summarizePullRequest("not json"), undefined);
  assert.equal(summarizePullRequest("{}"), undefined);
});

test("facts are reused for 20 seconds within a thread", async () => {
  const cache = new LiveFactsCache();
  let collections = 0;
  const collect = async () => `facts ${(collections += 1)}`;
  assert.equal(await cache.get("k", 0, collect), "facts 1");
  assert.equal(await cache.get("k", 19_999, collect), "facts 1");
  assert.equal(await cache.get("other", 20_000, collect), "facts 2");
  assert.equal(await cache.get("other", 40_001, collect), "facts 3");
});

test("/btw shows the collecting status and puts the facts in section 6; liveFacts false skips them", async () => {
  let release: (() => void) | undefined;
  const runCommand = async (_command: string, args: readonly string[]) => {
    if (args.includes("--show-toplevel")) {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return "/repo\n";
    }
    return args.includes("status") ? "## main\n" : undefined;
  };
  const harness = createBtwHarness({ settings: { liveFacts: true }, dependencies: { runCommand } });
  const closed = harness.run("r u rebasing?");
  await harness.settle();
  assert.match(harness.view.render(100).join("\n"), /collecting repository facts…/u);
  release?.();
  await harness.settle();
  assert.match(harness.promptOf(0), /## Live repository facts\nCollected by pi-btw at [\d:]+ with read-only git and gh commands\.\n\n### \/repo \(the session's working directory\)\n\$ git status -sb\n## main\n/u);
  harness.press(KEYS.ctrlC);
  await closed;

  const off = createBtwHarness({ settings: { liveFacts: false }, dependencies: { runCommand: async () => assert.fail("no commands") } });
  const offClosed = off.run("q");
  await off.settle();
  assert.doesNotMatch(off.promptOf(0), /Live repository facts/u);
  off.press(KEYS.ctrlC);
  await offClosed;
});
