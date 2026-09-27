import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import {
  BTW_SETTINGS_FILE,
  DEFAULT_BTW_SETTINGS,
  normalizeBtwSettings,
  parseBtwModelReference,
  readBtwSettings,
} from "../src/settings.js";

async function withSettingsFile(contents: string | undefined, run: (path: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "pi-btw-settings-"));
  const path = join(directory, BTW_SETTINGS_FILE);
  try {
    if (contents !== undefined) await writeFile(path, contents);
    await run(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("a missing settings file gives the defaults silently and is never created", async () => {
  await withSettingsFile(undefined, async (path) => {
    const result = await readBtwSettings(path);
    assert.deepEqual(result, { settings: { thinkingLevel: "low", liveFacts: true }, warnings: [] });
    assert.equal(existsSync(path), false);
  });
});

test("all three settings are read, including thinkingLevel main", () => {
  assert.deepEqual(normalizeBtwSettings({ model: "openrouter/anthropic/claude", thinkingLevel: "main", liveFacts: false }), {
    settings: { model: "openrouter/anthropic/claude", thinkingLevel: "main", liveFacts: false },
    warnings: [],
  });
  assert.equal(normalizeBtwSettings({ thinkingLevel: "high" }).settings.thinkingLevel, "high");
});

test("upstream's keys are ignored with one warning naming them", () => {
  const result = normalizeBtwSettings({
    thinkingLevel: "medium",
    keybindings: { exit: "ctrl+q" },
    layout: "left-pane",
    sidePaneRatio: 0.5,
    fullscreenCopyOnSelect: false,
    rememberThinkingLevelChanges: true,
  });
  assert.deepEqual(result.settings, { thinkingLevel: "medium", liveFacts: true });
  assert.equal(result.warnings.length, 1);
  for (const key of ["keybindings", "layout", "sidePaneRatio", "fullscreenCopyOnSelect", "rememberThinkingLevelChanges"]) {
    assert.match(result.warnings[0] ?? "", new RegExp(`"${key}"`));
  }
});

test("each invalid value falls back to its own default with a warning", () => {
  const result = normalizeBtwSettings({ model: "no-slash", thinkingLevel: "huge", liveFacts: "yes" });
  assert.deepEqual(result.settings, DEFAULT_BTW_SETTINGS);
  assert.equal(result.warnings.length, 3);
  const valid = normalizeBtwSettings({ model: "a/b", thinkingLevel: 3 });
  assert.deepEqual(valid.settings, { model: "a/b", thinkingLevel: "low", liveFacts: true });
  assert.equal(valid.warnings.length, 1);
});

test("unreadable documents fall back to the defaults with a warning", async () => {
  for (const contents of ["{not json", "[1,2]", "null", `{"model": "${"x".repeat(70_000)}"}`]) {
    await withSettingsFile(contents, async (path) => {
      const result = await readBtwSettings(path);
      assert.deepEqual(result.settings, DEFAULT_BTW_SETTINGS);
      assert.equal(result.warnings.length, 1, contents.slice(0, 20));
    });
  }
});

test("parseBtwModelReference splits only the first slash", () => {
  assert.deepEqual(parseBtwModelReference("openrouter/anthropic/claude-sonnet"), {
    provider: "openrouter",
    modelId: "anthropic/claude-sonnet",
  });
  for (const invalid of ["invalid", "/model", "provider/", " provider/model", "provider/\nmodel"]) {
    assert.equal(parseBtwModelReference(invalid), undefined, invalid);
  }
});
