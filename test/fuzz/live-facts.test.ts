import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import fc from "fast-check";
import { test } from "vitest";
import { collectLiveFacts, LIVE_FACTS_CACHE_MS, LiveFactsCache, recentDirectories, summarizePullRequest } from "../../src/live-facts.js";

// FUZZ_RUNS scales every property; `npm run fuzz` raises it.
const RUNS = Number(process.env.FUZZ_RUNS ?? 200);
const TIMEOUT = Math.max(10_000, RUNS * 40);
const options = { numRuns: RUNS, ...(process.env.FUZZ_SEED ? { seed: Number(process.env.FUZZ_SEED) } : {}) };

const path = fc.oneof(
  fc.constantFrom("/", "~", "~/", homedir(), tmpdir(), `${tmpdir()}/does/not/exist.rs`, "/dev/null", "relative/path", "./x", "../y", ""),
  fc.string(),
);
const quoted = path.chain((value) => fc.constantFrom(value, `"${value}"`, `'${value}'`));
const command = fc
  .array(fc.oneof(quoted.map((value) => `cd ${value}`), quoted, fc.constantFrom("&&", ";", "|", "2>/dev/null", "(", ")", "cargo test", "git -C"), fc.string()), {
    maxLength: 8,
  })
  .map((parts) => parts.join(" "));
const call = fc.oneof(
  command.map((value) => ({ name: "bash", arguments: { command: value } })),
  fc.record({ name: fc.constantFrom("read", "edit", "write", "grep", "ls", "custom"), arguments: fc.oneof(fc.record({ path }), fc.anything()) }),
  fc.anything(),
);
const branch = fc.array(
  fc.oneof(
    fc.array(call, { maxLength: 3 }).map((calls) => ({
      type: "message",
      message: { role: "assistant", content: calls.map((value) => (typeof value === "object" && value ? { type: "toolCall", ...value } : value)) },
    })),
    fc.anything(),
  ),
  { maxLength: 40 },
);

test("recent directories are existing absolute directories, never the root", { timeout: TIMEOUT }, () => {
  fc.assert(
    fc.property(branch, (entries) => {
      const directories = recentDirectories(entries);
      assert.ok(directories.length <= 6);
      assert.equal(new Set(directories).size, directories.length);
      for (const directory of directories) {
        assert.ok(directory.startsWith("/") && directory !== "/", directory);
        assert.ok(statSync(directory).isDirectory(), directory);
      }
    }),
    options,
  );
});

test("live facts run only read-only git and gh commands, and survive any output", { timeout: TIMEOUT }, async () => {
  const output = fc.option(fc.oneof(fc.string(), fc.string({ unit: "binary" }), fc.json(), fc.constant("/repo\n")), { nil: undefined });
  await fc.assert(
    fc.asyncProperty(fc.array(output, { minLength: 1, maxLength: 12 }), branch, async (outputs, entries) => {
      const calls: Array<{ command: string; args: readonly string[] }> = [];
      let index = 0;
      const run = async (commandName: string, args: readonly string[]) => {
        calls.push({ command: commandName, args });
        return outputs[index++ % outputs.length];
      };
      const facts = await collectLiveFacts({ cwd: tmpdir(), branch: entries, run });
      assert.ok(facts === undefined || typeof facts === "string");
      for (const { command: name, args } of calls) {
        if (name === "gh") assert.deepEqual(args.slice(0, 2), ["pr", "view"]);
        else {
          assert.equal(name, "git");
          assert.equal(args[0], "-C");
          assert.ok(["rev-parse", "status", "log"].includes(String(args[2])), args.join(" "));
        }
      }
      assert.ok(new Set(calls.filter((entry) => entry.args.includes("--show-toplevel")).map((entry) => entry.args[1])).size <= 7);
    }),
    { ...options, numRuns: Math.max(20, Math.floor(RUNS / 2)) },
  );
});

test("pull request summaries accept any JSON", { timeout: TIMEOUT }, () => {
  const check = fc.record(
    { name: fc.string(), context: fc.string(), status: fc.anything(), conclusion: fc.anything(), state: fc.anything() },
    { requiredKeys: [] },
  );
  fc.assert(
    fc.property(
      fc.oneof(
        fc.anything(),
        fc.record({ number: fc.oneof(fc.integer(), fc.anything()), title: fc.anything(), state: fc.anything(), isDraft: fc.anything(), url: fc.anything(), statusCheckRollup: fc.oneof(fc.array(check), fc.anything()) }, { requiredKeys: [] }),
      ),
      (value) => {
        const summary = summarizePullRequest(JSON.stringify(value) ?? "");
        assert.ok(summary === undefined || summary.startsWith("PR #"));
      },
    ),
    options,
  );
});

test("the facts cache collects again only when the key changes or 20 seconds pass", { timeout: TIMEOUT }, async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(fc.tuple(fc.integer({ min: 0, max: 30_000 }), fc.constantFrom("a", "b")), { maxLength: 30 }), async (steps) => {
      const cache = new LiveFactsCache();
      let now = 0;
      let collections = 0;
      let expected = 0;
      let last: { key: string; at: number } | undefined;
      for (const [elapsed, key] of steps) {
        now += elapsed;
        if (!last || last.key !== key || now - last.at >= LIVE_FACTS_CACHE_MS) {
          expected += 1;
          last = { key, at: now };
        }
        await cache.get(key, now, async () => `facts ${(collections += 1)}`);
        assert.equal(collections, expected);
      }
    }),
    options,
  );
});
