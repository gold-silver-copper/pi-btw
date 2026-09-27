import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const BTW_SETTINGS_FILE = "pi-btw.json";
export const BTW_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type BtwThinkingLevel = (typeof BTW_THINKING_LEVELS)[number];
const MAX_SETTINGS_BYTES = 64 * 1024;
const KNOWN_KEYS = new Set(["model", "thinkingLevel", "liveFacts"]);

export interface BtwSettings {
  /** `provider/model-id`; the main session's model when omitted. */
  model?: string;
  /** `"main"` follows the main thread's level. */
  thinkingLevel: BtwThinkingLevel | "main";
  liveFacts: boolean;
}

export interface BtwSettingsResult {
  settings: BtwSettings;
  warnings: string[];
}

export const DEFAULT_BTW_SETTINGS: Readonly<BtwSettings> = { thinkingLevel: "low", liveFacts: true };

export function btwSettingsPath(): string {
  return join(getAgentDir(), BTW_SETTINGS_FILE);
}

/** Read `pi-btw.json` for one `/btw` invocation. pi-btw never writes it. */
export async function readBtwSettings(settingsPath = btwSettingsPath()): Promise<BtwSettingsResult> {
  let contents: Buffer;
  try {
    contents = await readFile(settingsPath);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { settings: { ...DEFAULT_BTW_SETTINGS }, warnings: [] };
    return fallback(`${BTW_SETTINGS_FILE} could not be read; using defaults.`);
  }
  if (contents.byteLength > MAX_SETTINGS_BYTES) {
    return fallback(`${BTW_SETTINGS_FILE} is larger than ${MAX_SETTINGS_BYTES} bytes; using defaults.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents.toString("utf8"));
  } catch {
    return fallback(`${BTW_SETTINGS_FILE} is not valid JSON; using defaults.`);
  }
  return normalizeBtwSettings(parsed);
}

/** Every value falls back to its default on its own; nothing here throws. */
export function normalizeBtwSettings(value: unknown): BtwSettingsResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fallback(`${BTW_SETTINGS_FILE} must hold a JSON object; using defaults.`);
  }
  const document = value as Record<string, unknown>;
  const settings: BtwSettings = { ...DEFAULT_BTW_SETTINGS };
  const warnings: string[] = [];
  const unknownKeys = Object.keys(document).filter((key) => !KNOWN_KEYS.has(key));
  if (unknownKeys.length > 0) {
    warnings.push(`${BTW_SETTINGS_FILE}: ignoring unknown settings ${unknownKeys.map((key) => JSON.stringify(key)).join(", ")}.`);
  }
  if (document.model !== undefined) {
    if (typeof document.model === "string" && parseBtwModelReference(document.model)) settings.model = document.model;
    else warnings.push(`${BTW_SETTINGS_FILE}: "model" must be "provider/model-id"; using the main session's model.`);
  }
  if (document.thinkingLevel !== undefined) {
    const level = document.thinkingLevel;
    if (level === "main" || BTW_THINKING_LEVELS.includes(level as BtwThinkingLevel)) {
      settings.thinkingLevel = level as BtwThinkingLevel | "main";
    } else {
      warnings.push(
        `${BTW_SETTINGS_FILE}: "thinkingLevel" must be "main" or one of ${BTW_THINKING_LEVELS.join(", ")}; using "${DEFAULT_BTW_SETTINGS.thinkingLevel}".`,
      );
    }
  }
  if (document.liveFacts !== undefined) {
    if (typeof document.liveFacts === "boolean") settings.liveFacts = document.liveFacts;
    else warnings.push(`${BTW_SETTINGS_FILE}: "liveFacts" must be true or false; using true.`);
  }
  return { settings, warnings };
}

export function parseBtwModelReference(reference: string): { provider: string; modelId: string } | undefined {
  if (/[\s\p{Cc}]/u.test(reference)) return undefined;
  const separator = reference.indexOf("/");
  if (separator <= 0 || separator === reference.length - 1) return undefined;
  return { provider: reference.slice(0, separator), modelId: reference.slice(separator + 1) };
}

function fallback(warning: string): BtwSettingsResult {
  return { settings: { ...DEFAULT_BTW_SETTINGS }, warnings: [warning] };
}
