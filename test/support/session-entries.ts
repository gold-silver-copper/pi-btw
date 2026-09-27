/** Session entries shaped like the ones pi 0.87 writes to its JSONL files. */

export const T0 = Date.parse("2026-09-27T12:00:00.000Z");
let sequence = 0;

export const minutes = (value: number) => T0 + value * 60_000;
const iso = (at: number) => new Date(at).toISOString();
const id = () => (sequence += 1).toString(16).padStart(8, "0");

export function userEntry(text: string, at: number) {
  return {
    type: "message",
    id: id(),
    parentId: null,
    timestamp: iso(at),
    message: { role: "user", content: [{ type: "text", text }], timestamp: at },
  };
}

export function assistantEntry(content: unknown[], at: number, stopReason = "toolUse") {
  return {
    type: "message",
    id: id(),
    parentId: null,
    timestamp: iso(at),
    message: {
      role: "assistant",
      content,
      api: "claude-bridge",
      provider: "claude-bridge",
      model: "claude-opus-5-5",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason,
      timestamp: at - 5_000,
    },
  };
}

export const text = (value: string) => ({ type: "text", text: value });
export const thinking = (value: string) => ({ type: "thinking", thinking: value, thinkingSignature: "sig" });
export const toolCall = (callId: string, name: string, args: Record<string, unknown>) => ({
  type: "toolCall",
  id: callId,
  name,
  arguments: args,
});

export function toolResultEntry(callId: string, toolName: string, output: string, at: number, isError = false) {
  return {
    type: "message",
    id: id(),
    parentId: null,
    timestamp: iso(at),
    message: {
      role: "toolResult",
      toolCallId: callId,
      toolName,
      content: [{ type: "text", text: output }],
      ...(isError ? { details: {} } : {}),
      isError,
      timestamp: at,
    },
  };
}

export function goalStateEntry(goal: Record<string, unknown> | null, at: number) {
  return { type: "custom", customType: "goal-state", data: { goal }, id: id(), parentId: null, timestamp: iso(at) };
}

export function compactionEntry(summary: string, at: number) {
  return {
    type: "compaction",
    id: id(),
    parentId: null,
    timestamp: iso(at),
    summary,
    firstKeptEntryId: "00000001",
    tokensBefore: 150_000,
  };
}

export function goalContractEntry(content: string, at: number) {
  return { type: "custom_message", customType: "goal-contract", content, display: false, id: id(), parentId: null, timestamp: iso(at) };
}
