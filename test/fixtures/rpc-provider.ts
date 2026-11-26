import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ProviderConfig } from '@earendil-works/pi-coding-agent';
import { textContent } from '../../src/transcript.ts';
import { emptyUsage } from '../../src/usage.ts';
import { HANDOFF, HANDOFF_REQUEST } from '../../src/prompts.ts';

/** One request as the fixture model got it. */
export interface Sent { system: string; messages: string[]; last: string }

/** A model with no network: it answers `Reply: <request>`, a window's handoff request with `Handoff: …` and the compactor's
 * handoff with `Summary: …`. A request `CALL <tool> <JSON arguments>` calls that tool. `sent` records every request; `hold` keeps a reply back until the promise it returns settles (returning a string replaces the reply text, or a `CALL ...` triggers a tool call). Loaded by `pi -e`
 * too, for the real RPC test. */
export function fixtureProvider(sent: Sent[] = [], hold?: (request: string, lastRole?: string) => Promise<string | void> | string | undefined): ProviderConfig {
  return {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
    models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple(model, context, options) {
      const messages = context.messages.filter(m => m.role !== 'system'), system = JSON.stringify(context.messages.filter(m => m.role === 'system'));
      const last = messages.at(-1), text = textContent(last && 'content' in last ? last.content : '');
      // The view comes before the request in the same message.
      const end = text.lastIndexOf('</chat>'), request = (end >= 0 ? text.slice(end + '</chat>'.length) : text).trim();
      sent.push({ system, messages: messages.map(m => JSON.stringify(m)), last: request });
      const defaultReply = system.includes(JSON.stringify(HANDOFF).slice(1, 40)) ? `Summary: ${request.slice(0, 2000)}` : request.startsWith(HANDOFF_REQUEST) ? 'Handoff: the user asked about the colour; I answered.' : `Reply: ${request}`;
      const build = (override?: string): AssistantMessage => {
        const source = override ?? request;
        const call = last?.role === 'toolResult' && override === undefined ? undefined : /^CALL (\w+) (\{.*\})$/s.exec(source);
        const reply = override ?? defaultReply;
        return { role: 'assistant', content: [call ? { type: 'toolCall', id: `call-${sent.length}`, name: call[1], arguments: JSON.parse(call[2]) } : { type: 'text', text: reply.slice(0, 400) }],
          api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: call ? 'toolUse' : 'stop', usage: emptyUsage() };
      };
      const stream = createAssistantMessageEventStream();
      let done = false;
      const abort = () => {
        if (done) return;
        done = true;
        const aborted: AssistantMessage = { ...build(), content: [], stopReason: 'aborted', errorMessage: 'aborted' };
        stream.push({ type: 'error', reason: 'aborted', error: aborted }); stream.end();
      };
      options?.signal?.addEventListener('abort', abort, { once: true });
      if (options?.signal?.aborted) { abort(); return stream; }
      void Promise.resolve(hold?.(request, last?.role)).then(override => {
        options?.signal?.removeEventListener('abort', abort);
        if (done) return;
        done = true;
        const message = build(typeof override === 'string' ? override : undefined);
        stream.push({ type: 'start', partial: message }); stream.push({ type: 'done', reason: message.stopReason === 'toolUse' ? 'toolUse' : 'stop', message }); stream.end();
      }, error => {
        options?.signal?.removeEventListener('abort', abort);
        if (done) return;
        done = true;
        const failed: AssistantMessage = { ...build(), content: [], stopReason: 'error', errorMessage: error instanceof Error ? error.message : String(error) };
        stream.push({ type: 'error', reason: 'error', error: failed }); stream.end();
      });
      return stream;
    },
  };
}

export default function (pi: ExtensionAPI) { pi.registerProvider('fixture', fixtureProvider()); }
