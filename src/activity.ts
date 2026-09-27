import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface RunningTool {
  name: string;
  args: unknown;
  startedAt: number;
}

/** What the main agent is doing, from pi's events; pi keeps none of this in the session. */
export interface MainAgentActivity {
  running: boolean;
  runStartedAt?: number;
  lastActivityAt?: number;
  lastActivity?: string;
  tools: Map<string, RunningTool>;
}

export function trackMainAgent(pi: ExtensionAPI, now: () => number = Date.now): MainAgentActivity {
  const activity: MainAgentActivity = { running: false, tools: new Map() };
  const touch = (what: string) => {
    activity.lastActivityAt = now();
    activity.lastActivity = what;
  };
  pi.on("session_start", () => {
    activity.running = false;
    activity.runStartedAt = undefined;
    activity.lastActivityAt = undefined;
    activity.lastActivity = undefined;
    activity.tools.clear();
  });
  pi.on("agent_start", () => {
    activity.running = true;
    activity.runStartedAt = now();
    touch("run started");
  });
  pi.on("agent_end", () => {
    activity.running = false;
    activity.tools.clear();
    touch("run ended");
  });
  pi.on("message_end", (event) => {
    const role = (event.message as { role?: unknown } | undefined)?.role;
    if (role === "assistant") touch("assistant message");
  });
  pi.on("tool_execution_start", (event) => {
    activity.tools.set(event.toolCallId, { name: event.toolName, args: event.args, startedAt: now() });
    touch(`${event.toolName} started`);
  });
  pi.on("tool_execution_end", (event) => {
    activity.tools.delete(event.toolCallId);
    touch(`${event.toolName} ${event.isError ? "failed" : "finished"}`);
  });
  return activity;
}
