import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { getCurrentSystemPrompt, type Message } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { textContent } from './transcript.ts';

export const BRIDGE_PROVIDER = 'claude-bridge';
export const bridgeEnabled = () => process.env.OPTCHAT_CLAUDE_BRIDGE === '1';
export const usesBridge = (model?: { provider: string }) => model?.provider === BRIDGE_PROVIDER;

/** Catch common ways Claude Code would use paid API credentials instead of its login. */
export function assertSubscriptionEnvironment() {
  const overrides = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
    'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'];
  const present = overrides.filter(name => process.env[name] && process.env[name] !== '0');
  if (present.length) throw new Error(`OptChat's subscription bridge experiment refuses API/proxy overrides: ${present.join(', ')}. Unset them before enabling it.`);
}

/** Experimental, opt-in only. Load upstream code, not an OAuth/fingerprint imitation. */
export async function registerBridge(pi: ExtensionAPI) {
  assertSubscriptionEnvironment();
  // Upstream ships TS source, not declarations. Keep its implementation outside our tsc graph.
  const entry: string = 'pi-claude-bridge/src/index.ts';
  const { default: bridge }: { default: (pi: ExtensionAPI) => void } = await import(entry);
  bridge(pi);
}

/** 0.9.1 projects customPrompt/contextFiles/skills, but not Pi's sections. */
export function bridgePrompt(preamble: string, instructions: string) {
  return `${preamble}\n\n<instructions>\n${instructions}\n</instructions>`;
}

/** Keep the exact assembled prompt recorded by the bridge's lifecycle hooks. */
export function contextPrompt(messages: AgentMessage[], fallback: string, model?: { provider: string }) {
  if (!usesBridge(model)) return fallback;
  const prompt = getCurrentSystemPrompt(messages);
  if (!prompt) {
    throw new Error('Claude bridge requires the assembled system prompt; refusing an uncaptured prompt.');
  }
  return prompt;
}

/** Isolated bridge summaries read the last user turn, not an assistant/user retry transcript. */
export function summaryMessages(messages: Message[], model: { provider: string }): Message[] {
  if (!usesBridge(model)) return messages;
  if (messages.length === 1 && messages[0].role === 'user') return messages;
  return [{ role: 'user', timestamp: Date.now(), content: messages.map(message =>
    `${message.role.toUpperCase()}:\n${textContent(message.content)}`).join('\n\n') }];
}

/** Upstream's marker for a tool-free, non-persistent, independent summary query. */
export const summaryCache = (model: { provider: string }) => usesBridge(model) ? 'none' as const : 'short' as const;
