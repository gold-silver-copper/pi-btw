import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterAll, test } from "vitest";
import { BTW_THINKING_LEVELS, normalizeBtwSettings, parseBtwModelReference, readBtwSettings } from "../../src/settings.js";
import { BTW_THREAD_ENTRY_TYPE, MAX_ANSWER_CHARS, MAX_THREAD_TURNS, restoreThreadTurns } from "../../src/side-thread.js";

// FUZZ_RUNS scales every property; `npm run fuzz` raises it.
const RUNS = Number(process.env.FUZZ_RUNS ?? 300);
const TIMEOUT = Math.max(10_000, RUNS * 40);
const options = { numRuns: RUNS, ...(process.env.FUZZ_SEED ? { seed: Number(process.env.FUZZ_SEED) } : {}) };

const directory = mkdtempSync(join(tmpdir(), "pi-btw-fuzz-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const settingsValue = fc.oneof(
  fc.anything(),
  fc.record(
    {
      model: fc.oneof(fc.string(), fc.anything()),
      thinkingLevel: fc.oneof(fc.constantFrom(...BTW_THINKING_LEVELS, "main"), fc.anything()),
      liveFacts: fc.oneof(fc.boolean(), fc.anything()),
      layout: fc.anything(),
      keybindings: fc.anything(),
    },
    { requiredKeys: [] },
  ),
);

function assertValidSettings(result: Awaited<ReturnType<typeof readBtwSettings>>) {
  const { settings, warnings } = result;
  assert.ok(settings.thinkingLevel === "main" || BTW_THINKING_LEVELS.includes(settings.thinkingLevel));
  assert.equal(typeof settings.liveFacts, "boolean");
  assert.ok(settings.model === undefined || parseBtwModelReference(settings.model) !== undefined);
  assert.ok(Array.isArray(warnings) && warnings.every((warning) => typeof warning === "string"));
}

test("the settings reader accepts anything and returns valid settings", { timeout: TIMEOUT }, () => {
  fc.assert(
    fc.property(settingsValue, (value) => {
      const result = normalizeBtwSettings(value);
      assertValidSettings(result);
      const unknown = typeof value === "object" && value !== null && !Array.isArray(value)
        ? Object.keys(value).filter((key) => !["model", "thinkingLevel", "liveFacts"].includes(key))
        : [];
      assert.ok(result.warnings.filter((warning) => warning.includes("unknown settings")).length === (unknown.length > 0 ? 1 : 0));
    }),
    options,
  );
});

test("the settings file reader survives any bytes", { timeout: TIMEOUT }, async () => {
  const path = join(directory, "pi-btw.json");
  await fc.assert(
    fc.asyncProperty(
      fc.oneof(fc.uint8Array({ maxLength: 300 }), settingsValue.map((value) => new TextEncoder().encode(JSON.stringify(value) ?? ""))),
      async (bytes) => {
        writeFileSync(path, bytes);
        assertValidSettings(await readBtwSettings(path));
      },
    ),
    { ...options, numRuns: Math.max(20, Math.floor(RUNS / 5)) },
  );
});

const turnLike = fc.oneof(
  fc.anything(),
  fc.record(
    {
      question: fc.oneof(fc.string(), fc.anything()),
      answer: fc.oneof(fc.string(), fc.constant("A".repeat(MAX_ANSWER_CHARS + 10)), fc.anything()),
      at: fc.oneof(fc.double(), fc.anything()),
      model: fc.oneof(fc.string(), fc.anything()),
      error: fc.anything(),
    },
    { requiredKeys: [] },
  ),
);
const entry = fc.oneof(
  fc.anything(),
  fc.record({
    type: fc.constantFrom("custom", "custom_message", "message"),
    customType: fc.constantFrom(BTW_THREAD_ENTRY_TYPE, "goal-state"),
    data: fc.oneof(fc.anything(), fc.record({ turns: fc.oneof(fc.array(turnLike, { maxLength: 40 }), fc.anything()) })),
  }),
);

test("thread restore accepts any entries and returns well-formed turns", { timeout: TIMEOUT }, () => {
  fc.assert(
    fc.property(fc.array(entry, { maxLength: 20 }), (entries) => {
      const turns = restoreThreadTurns(entries);
      assert.ok(turns.length <= MAX_THREAD_TURNS);
      for (const turn of turns) {
        assert.equal(typeof turn.question, "string");
        assert.equal(typeof turn.answer, "string");
        assert.ok(turn.answer.length <= MAX_ANSWER_CHARS);
        assert.ok(Number.isFinite(turn.at));
        assert.equal(typeof turn.model, "string");
        assert.ok(turn.error === undefined || turn.error === true);
      }
    }),
    options,
  );
});
