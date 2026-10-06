import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createCompressor, SCALE } from '../src/compactor.ts';
import { createHandoffSummarizer } from '../src/handoff.ts';
import type { RunInfo } from '../src/runs.ts';
import { bytes, NODE } from '../src/memory.ts';
import { emptyUsage } from '../src/usage.ts';

let sentReasoning: string | undefined;
let sentStep = '';
/** A fake model whose first reply is `first` bytes long and whose retries fit. */
async function attempts(first: number, { source = 'user: ' + 'a long message '.repeat(70), merge = false, accepted }: { source?: string; merge?: boolean; accepted?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-size-'));
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false });
  let calls = 0;
  runtime.registerProvider('optchat-test', {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
    // Like Sonnet 5.5: thinking can't be turned off.
    models: [{ id: 'compactor', name: 'Synthetic compactor', reasoning: true, thinkingLevelMap: { off: null, minimal: null }, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple(model, context, options) {
      sentReasoning = options?.reasoning;
      const request = context.messages.find(m => m.role === 'user')?.content;
      sentStep = Array.isArray(request) ? request.map(c => c.type === 'text' ? c.text : '').at(-1) ?? '' : request ?? '';
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(calls++ ? 400 : first) }], api: model.api,
        provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: 'stop', usage: emptyUsage() };
      queueMicrotask(() => { stream.push({ type: 'done', reason: 'stop', message }); stream.end(); });
      return stream;
    },
  });
  try {
    const compress = createCompressor(new ModelRegistry(runtime), () => ({ provider: 'optchat-test', model: 'compactor', thinking: 'off' }), undefined,
      accepted === undefined ? undefined : () => accepted);
    const line = await compress({ context: '<chat>\n</chat>', source, merge }, new AbortController().signal);
    return { calls, bytes: line.length };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('a summary up to 640 bytes is kept; one over 640 is retried', async () => {
  assert.deepEqual(await attempts(640), { calls: 1, bytes: 640 });
  assert.deepEqual(await attempts(641), { calls: 2, bytes: 400 });
});

test('the profile\'s summary size tolerance decides when a line is retried', async () => {
  assert.deepEqual(await attempts(513, { accepted: 512 }), { calls: 2, bytes: 400 }, '512 is Victor\'s strict rule');
  assert.deepEqual(await attempts(700, { accepted: 700 }), { calls: 1, bytes: 700 });
});

test('a thinking level the model can\'t take is clamped like Pi does, not sent as none (which Sonnet 5.5 runs at high effort)', async () => {
  await attempts(400);
  assert.equal(sentReasoning, 'low', 'the fixture asks for "off"');
});

test('a merge that is not smaller than the two lines it replaces is retried', async () => {
  const children = ['a'.repeat(280), 'b'.repeat(280)].join('\n'); // 561 bytes
  assert.deepEqual(await attempts(590, { source: children, merge: true }), { calls: 2, bytes: 400 });
  assert.deepEqual(await attempts(590, { source: 'c'.repeat(1000), merge: true }), { calls: 1, bytes: 590 });
});

test('the size example the compactor is shown is a real line of exactly NODE bytes, not padding', () => {
  assert.equal(bytes(SCALE), NODE);
  assert.doesNotMatch(SCALE, /([^\w\s])\1\1/);
  // A copied example must not add plausible fake facts to memory: no PR numbers, commit-like ids or dates.
  assert.doesNotMatch(SCALE, /#\d|\b[0-9a-f]{7,}\b|\b20\d\d\b/);
});

test('the size example is fenced off from the input, so it is never summarized as chat', async () => {
  const source = 'user: ' + 'a long message '.repeat(70);
  await attempts(400, { source });
  assert.ok(sentStep.includes(`<example>${SCALE}</example>`));
  assert.ok(sentStep.endsWith(`<input>\n${source}\n</input>`));
});

test('handoffs clamp the compactor\'s thinking level too', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-size-'));
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false });
  let sent: string | undefined;
  runtime.registerProvider('optchat-test', {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
    models: [{ id: 'compactor', name: 'Synthetic compactor', reasoning: true, thinkingLevelMap: { off: null, minimal: null }, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple(model, _context, options) {
      sent = options?.reasoning;
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'Handoff.' }], api: model.api,
        provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: 'stop', usage: emptyUsage() };
      queueMicrotask(() => { stream.push({ type: 'done', reason: 'stop', message }); stream.end(); });
      return stream;
    },
  });
  try {
    const summarize = createHandoffSummarizer(new ModelRegistry(runtime), () => ({ provider: 'optchat-test', model: 'compactor', thinking: 'off' }), () => {});
    const run: RunInfo = { id: 'a1', task: 'Task', cwd: dir, model: 'optchat-test/compactor', thinking: 'off', parentSession: 'main', started: 0, depth: 1, state: 'completed', guidance: [] };
    assert.equal(await summarize(run, []), 'Handoff.');
    assert.equal(sent, 'low', 'the fixture asks for "off"');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
