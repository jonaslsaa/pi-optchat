import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ProviderConfig } from '@earendil-works/pi-coding-agent';
import { textContent } from '../../src/transcript.ts';
import { emptyUsage } from '../../src/usage.ts';
import { HANDOFF, HANDOFF_REQUEST } from '../../src/prompts.ts';

/** One request as the fixture model got it. */
export interface Sent { system: string; messages: string[]; last: string }

/** A model with no network: it answers `Reply: <request>`, a window's handoff request with `Handoff: …` and the compactor's
 * handoff with `Summary: …`. `sent` records every request. Loaded by `pi -e` too, for the real RPC test. */
export function fixtureProvider(sent: Sent[] = []): ProviderConfig {
  return {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
    models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple(model, context) {
      const messages = context.messages.filter(m => m.role !== 'system'), system = JSON.stringify(context.messages.filter(m => m.role === 'system'));
      const last = messages.at(-1), text = textContent(last && 'content' in last ? last.content : '');
      // The view comes before the request in the same message.
      const end = text.lastIndexOf('</chat>'), request = (end >= 0 ? text.slice(end + '</chat>'.length) : text).trim();
      sent.push({ system, messages: messages.map(m => JSON.stringify(m)), last: request });
      const reply = system.includes(JSON.stringify(HANDOFF).slice(1, 40)) ? `Summary: ${request.slice(0, 2000)}` : request.startsWith(HANDOFF_REQUEST) ? 'Handoff: the user asked about the colour; I answered.' : `Reply: ${request}`;
      const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: reply.slice(0, 400) }],
        api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: 'stop', usage: emptyUsage() };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => { stream.push({ type: 'start', partial: message }); stream.push({ type: 'done', reason: 'stop', message }); stream.end(); });
      return stream;
    },
  };
}

export default function (pi: ExtensionAPI) { pi.registerProvider('fixture', fixtureProvider()); }
