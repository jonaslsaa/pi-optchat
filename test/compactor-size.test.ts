import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createCompressor, SCALE } from '../src/compactor.ts';
import { bytes, NODE } from '../src/memory.ts';
import { emptyUsage } from '../src/usage.ts';

/** A fake model whose first reply is `first` bytes long and whose retries fit. */
async function attempts(first: number, source = 'user: ' + 'a long message '.repeat(70), merge = false) {
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
  try {
    const compress = createCompressor(new ModelRegistry(runtime), () => ({ provider: 'optchat-test', model: 'compactor', thinking: 'off' }));
    const line = await compress({ context: '<chat>\n</chat>', source, merge }, new AbortController().signal);
    return { calls, bytes: line.length };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('a summary up to 640 bytes is kept; one over 640 is retried', async () => {
  assert.deepEqual(await attempts(640), { calls: 1, bytes: 640 });
  assert.deepEqual(await attempts(641), { calls: 2, bytes: 400 });
});

test('a merge that is not smaller than the two lines it replaces is retried', async () => {
  const children = ['a'.repeat(280), 'b'.repeat(280)].join('\n'); // 561 bytes
  assert.deepEqual(await attempts(590, children, true), { calls: 2, bytes: 400 });
  assert.deepEqual(await attempts(590, 'c'.repeat(1000), true), { calls: 1, bytes: 590 });
});

test('the size example the compactor is shown is a real line of exactly NODE bytes, not padding', () => {
  assert.equal(bytes(SCALE), NODE);
  assert.doesNotMatch(SCALE, /([^\w\s])\1\1/);
});
