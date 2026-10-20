import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createHandoffSummarizer } from '../src/handoff.ts';
import type { RunInfo } from '../src/runs.ts';
import { emptyUsage } from '../src/usage.ts';
import { removeDir } from './support.ts';

test('a dropped connection while writing a handoff is asked again, so the real summary is delivered', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-handoff-'));
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false });
  let calls = 0;
  runtime.registerProvider('optchat-test', {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'anthropic-messages',
    models: [{ id: 'compactor', name: 'Synthetic compactor', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple(model) {
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'Handoff.' }], api: model.api,
        provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: 'stop', usage: emptyUsage() };
      const dropped = calls++ === 0;
      queueMicrotask(() => {
        if (dropped) { message.stopReason = 'error'; message.errorMessage = 'terminated'; stream.push({ type: 'error', reason: 'error', error: message }); }
        else stream.push({ type: 'done', reason: 'stop', message });
        stream.end();
      });
      return stream;
    },
  });
  try {
    const summarize = createHandoffSummarizer(new ModelRegistry(runtime), () => ({ provider: 'optchat-test', model: 'compactor', thinking: 'off' }), () => {}, [0, 0]);
    const run: RunInfo = { id: 'a1', task: 'Task', cwd: dir, model: 'optchat-test/compactor', thinking: 'off', parentSession: 'main', started: 0, depth: 1, state: 'completed', guidance: [] };
    assert.equal(await summarize(run, []), 'Handoff.');
    assert.equal(calls, 2);
  } finally { removeDir(dir); }
});
