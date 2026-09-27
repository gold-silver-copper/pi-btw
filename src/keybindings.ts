import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, type KeyId, matchesKey } from "@earendil-works/pi-tui";
import { formatKeyLabel } from "./text.js";

/** Fixed workspace keys. Only the thinking-cycle key follows pi's keybindings. */
export const BTW_KEYS = { exit: "ctrl+c", bringBack: "ctrl+r" } as const;
export type BtwAction = keyof typeof BTW_KEYS | "cycleThinking";

export interface BtwShortcuts {
  matches(data: string, action: BtwAction): boolean;
  /** Display label, or undefined when the action has no key. */
  label(action: BtwAction): string | undefined;
}

export function createBtwShortcuts(keybindings?: Pick<KeybindingsManager, "getKeys">): BtwShortcuts {
  const fixed = Object.values(BTW_KEYS) as string[];
  const cycle = (keybindings?.getKeys("app.thinking.cycle") ?? ["shift+tab"])
    .map(String)
    .filter((key) => !fixed.includes(key.toLowerCase()));
  const keys = (action: BtwAction): string[] => (action === "cycleThinking" ? cycle : [BTW_KEYS[action]]);
  return {
    matches: (data, action) => !isKeyRelease(data) && keys(action).some((key) => matchesKey(data, key as KeyId)),
    label: (action) => {
      const [key] = keys(action);
      return key ? formatKeyLabel(key) : undefined;
    },
  };
}

/** Keep split bracketed-paste payloads away from workspace shortcuts. */
export class BtwPasteGuard {
  private active = false;
  consume(data: string): boolean {
    const wasActive = this.active;
    const starts = data.includes("\u001b[200~");
    if (starts) this.active = true;
    if (this.active && data.includes("\u001b[201~")) this.active = false;
    return wasActive || starts;
  }
}
