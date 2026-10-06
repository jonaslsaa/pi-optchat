import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createCompressor } from '../src/compactor.ts';
import { emptyUsage } from '../src/usage.ts';

/** A fake model whose first reply is `first` bytes long and whose retries fit. */
async function attempts(first: number) {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-size-'));
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false });
  let calls = 0;
  runtime.registerProvider('optchat-test', {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
    models: [{ id: 'compactor', name: 'Synthetic compactor', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple(model) {
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(calls++ ? 400 : first) }], api: model.api,
        provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: 'stop', usage: emptyUsage() };
      queueMicrotask(() => { stream.push({ type: 'done', reason: 'stop', message }); stream.end(); });
      return stream;
    },
  });
  const compress = createCompressor(new ModelRegistry(runtime), () => ({ provider: 'optchat-test', model: 'compactor', thinking: 'off' }));
  const line = await compress({ context: '<chat>\n</chat>', source: 'user: a long message', merge: false }, new AbortController().signal);
  return { calls, bytes: line.length };
}

test('a summary a little over 512 bytes is kept; one far over is retried', async () => {
  assert.deepEqual(await attempts(600), { calls: 1, bytes: 600 });
  assert.deepEqual(await attempts(700), { calls: 2, bytes: 400 });
});
