import { setTimeout as sleep } from 'node:timers/promises';
import { clampThinkingLevel, isRetryableAssistantError, type Api, type AssistantMessage, type Message, type Model } from '@earendil-works/pi-ai';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { ModelRegistry } from '@earendil-works/pi-coding-agent';
import { compaction, tooLong } from './prompts.ts';
import { bytes, NODE, type Compressor } from './memory.ts';
import { cachePayload, record } from './cache.ts';
import { cacheGate, cachePlan, cacheRoute, type CacheRelease } from './cache-gate.ts';
import { DEFAULT_SETTINGS } from './settings.ts';
import { commonPrompt, type RequestPrefix } from './prefix.ts';

export interface ModelChoice { provider: string; model: string; thinking: ThinkingLevel }
/** A level the model can't take would be sent as no level, which Sonnet 5.5 runs at high effort; Pi's own sessions clamp the same way. */
export const reasoningFor = (model: Model<Api>, level: ThinkingLevel) => {
  const thinking = clampThinkingLevel(model, level);
  return thinking === 'off' ? undefined : thinking;
};
/** State the requested and effective effort separately when the SDK must clamp it. Never silently replace a model. */
export function describeChoice(registry: Pick<ModelRegistry, 'find'>, choice: ModelChoice) {
  const name = `${choice.provider}/${choice.model}`, model = registry.find(choice.provider, choice.model);
  if (!model) return `${name} (${choice.thinking} requested; model unavailable)`;
  const effective = clampThinkingLevel(model, choice.thinking);
  return `${name} (${effective === choice.thinking ? effective : `${choice.thinking} requested; using ${effective}`})`;
}
/** The model is asked for 512 bytes; `accepted` is the longest line kept without a retry (the profile's summary size tolerance). */
export function createCompressor(registry: ModelRegistry, choice: () => ModelChoice,
  onUsage: (message: AssistantMessage) => void = () => {}, accepted = () => DEFAULT_SETTINGS.summaryAcceptBytes,
  prefixSource: () => RequestPrefix = () => ({ system: { role: 'system', content: commonPrompt(), toolsAdded: [], timestamp: 0 }, runtime: '' }),
  retryDelays: readonly number[] = [1000, 2000]): Compressor {
  return async (input, signal) => {
    const selected = choice();
    const model = registry.find(selected.provider, selected.model);
    if (!model) throw new Error(`Compactor model unavailable: ${selected.provider}/${selected.model}. Use /optchat model.`);
    const thinking = reasoningFor(model, selected.thinking);
    const shared = structuredClone(prefixSource()), acceptedBytes = accepted();
    const auth = await registry.getApiKeyAndHeaders(model);
    if (!auth.ok) throw new Error(auth.error);
    const step = compaction(input);
    // OpenAI joins text blocks with nothing between them, so the task starts its own paragraph after the view.
    const messages: Message[] = [shared.system, { role: 'user', content: [{ type: 'text', text: input.context },
      ...shared.runtime ? [{ type: 'text' as const, text: `\n\n${shared.runtime}` }] : [], { type: 'text', text: `\n\n${step}` }], timestamp: Date.now() }];
    const route = cacheRoute(model, auth);
    const tries: string[] = [];
    const ask = async () => {
      let warmed: CacheRelease = () => {};
      try {
        const stream = registry.streamSimple(auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model, { messages }, {
          // A shared session id is the OpenAI prompt-cache key; SSE because over a websocket Codex would chain unrelated parallel calls on one cached connection.
          sessionId: 'optchat-compactor', transport: 'sse',
          reasoning: thinking, signal, cacheRetention: 'short',
          apiKey: auth.apiKey, headers: auth.headers, env: auth.env,
          onPayload: async payload => {
            if (model.api !== 'anthropic-messages') return payload;
            const marked = cachePayload(payload);
            warmed(false); warmed = await cacheGate.acquire(cachePlan(marked, route), route, signal);
            return marked;
          },
          onProviderStreamEvent: event => { if (record(event) && event.type === 'message_start') warmed(true); },
        });
        // The cache entry is usable once the model starts answering.
        for await (const event of stream) if (event.type !== 'start') { warmed(event.type !== 'error'); break; }
        return await stream.result();
      } finally { warmed(false); }
    };
    // Pi's agent loop retries a dropped connection itself; streamSimple doesn't, so a transient error is asked again before it surfaces.
    const answer = async () => {
      for (let retry = 0; ; retry++) {
        const reply = await ask();
        onUsage(reply);
        if (retry >= retryDelays.length || !isRetryableAssistantError(reply)) return reply;
        await sleep(retryDelays[retry], undefined, { signal });
      }
    };
    for (let attempt = 0; attempt < 5; attempt++) {
      const reply = await answer();
      if (reply.stopReason === 'error' || reply.stopReason === 'aborted') throw new Error(reply.errorMessage ?? `Compactor ${reply.stopReason}`);
      // A reply cut off at the token limit, or one that calls a tool, is no summary: ask again.
      if (reply.stopReason === 'length' || reply.content.some(c => c.type === 'toolCall')) continue;
      // The compactions' view shows each line under its id+n| head, which a line can copy.
      const line = reply.content.filter(c => c.type === 'text').map(c => c.text).join('').trim().replace(/^\d+\+\d+\|\s*/, '');
      if (!line) continue;
      tries.push(line);
      // A merge of two short lines can come back nearly as big as both, so a line must also shrink what it replaces.
      if (bytes(line) <= acceptedBytes && bytes(line) < bytes(input.source)) break;
      messages.push(reply);
      const cut = Buffer.from(line).subarray(0, NODE).toString('utf8').replace(/\uFFFD$/, '');
      messages.push({ role: 'user', content: tooLong(bytes(line), cut), timestamp: Date.now() });
    }
    if (!tries.length) throw new Error('Compactor returned no whole line in 5 tries.');
    return tries.reduce((a, b) => bytes(a) <= bytes(b) ? a : b);
  };
}
