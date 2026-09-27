/**
 * Development aid, never loaded by the package: sends side prompts the way
 * pi-claude-bridge sends a standalone side call (one tool-less, sessionless Claude Code
 * turn with pi-btw's system prompt and the whole request as one prompt string) and prints
 * the usage Claude Code reports, which the bridge does not pass back to pi.
 *
 *   BTW_AUDIT=1 npx vitest run test/audit.test.ts        # writes system.txt, question-1.txt, question-2.txt
 *   node test/fixtures/measure-bridge-cache.mjs /tmp/pi-btw-fork/system.txt \
 *     /tmp/pi-btw-fork/question-1.txt /tmp/pi-btw-fork/question-1.txt /tmp/pi-btw-fork/question-2.txt
 *
 * Makes live model calls. PI_CLAUDE_BRIDGE_DIR overrides where the bridge is installed.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const bridge = process.env.PI_CLAUDE_BRIDGE_DIR ?? join(homedir(), ".pi/agent/git/github.com/gold-silver-copper/pi-claude-bridge");
const { query } = await import(join(bridge, "node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs"));
const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi/agent");
const config = JSON.parse(readFileSync(join(agentDir, "claude-bridge.json"), "utf8"));
const model = process.env.BTW_MODEL ?? "claude-opus-5-5";
const [system, ...prompts] = process.argv.slice(2).map((path) => readFileSync(path, "utf8"));

for (const [index, prompt] of prompts.entries()) {
  const started = Date.now();
  const turn = query({
    prompt,
    options: {
      cwd: process.cwd(),
      env: { ...process.env, ENABLE_CLAUDEAI_MCP_SERVERS: "0", DISABLE_AUTO_COMPACT: "1" },
      settings: { autoMemoryEnabled: false },
      tools: [],
      strictMcpConfig: true,
      settingSources: [],
      skills: [],
      persistSession: false,
      systemPrompt: system,
      model,
      maxTurns: 1,
      ...(config.provider?.pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable: config.provider.pathToClaudeCodeExecutable } : {}),
    },
  });
  for await (const message of turn) {
    if (message.type !== "result") continue;
    const usage = message.usage ?? {};
    console.log(
      JSON.stringify({
        call: index + 1,
        promptChars: prompt.length,
        seconds: (Date.now() - started) / 1000,
        input: usage.input_tokens,
        cacheRead: usage.cache_read_input_tokens,
        cacheWrite: usage.cache_creation_input_tokens,
        output: usage.output_tokens,
        answer: String(message.result ?? "").slice(0, 300),
      }),
    );
  }
}
