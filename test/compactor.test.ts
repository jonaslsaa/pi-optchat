import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createCompressor } from '../src/compactor.ts';
import { emptyUsage } from '../src/usage.ts';
import { textContent } from '../src/transcript.ts';

/** A fake Anthropic model whose calls answer and finish only when the test says so. */
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-compactor-'));
  const calls: { source: string; answer: () => void; finish: () => void; fail: () => void }[] = [];
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false });
  runtime.registerProvider('optchat-test', {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'anthropic-messages',
    models: [{ id: 'compactor', name: 'Synthetic compactor', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 1000 }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      const source = textContent(context.messages.findLast(m => m.role === 'user')?.content).split('\n').at(-1) ?? '';
      const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: `summary of ${source}` }], api: model.api, provider: model.provider,
        model: model.id, timestamp: Date.now(), stopReason: 'stop', usage: emptyUsage() };
      stream.push({ type: 'start', partial: message });
      const step = <T>() => { let resolve = (_: T) => {}; return { promise: new Promise<T>(r => { resolve = r; }), resolve }; };
      const answered = step<boolean>(), finished = step<void>();
      calls.push({ source, answer: () => answered.resolve(true), fail: () => answered.resolve(false), finish: () => finished.resolve() });
      void (async () => {
        if (!await answered.promise) {
          message.stopReason = 'error'; message.errorMessage = 'overloaded';
          stream.push({ type: 'error', reason: 'error', error: message }); return stream.end();
        }
        stream.push({ type: 'text_delta', contentIndex: 0, delta: 'summary', partial: message });
        await finished.promise;
        stream.push({ type: 'done', reason: 'stop', message }); stream.end();
      })();
      return stream;
    },
  });
  const compress = createCompressor(new ModelRegistry(runtime), () => ({ provider: 'optchat-test', model: 'compactor', thinking: 'off' }));
  // Long enough for a cache mark, so the first 50k characters are a shared, cacheable prefix.
  const view = `<chat>\n${'0+1|user: an old remembered line\n'.repeat(2000)}</chat>`;
  // The compactor only sees sources over NODE bytes; the fake model reads just the last line.
  const run = (source: string, context = view, signal = new AbortController().signal) => compress({ context, source: `${'x'.repeat(600)}\n${source}`, merge: false }, signal);
  const settle = () => new Promise(resolve => setTimeout(resolve, 20));
  return { calls, run, settle, view };
}

test('parallel calls on a cold view wait until one call has started answering, and a warm view skips the wait', async () => {
  const { calls, run, settle, view } = await setup();
  const replies = ['a', 'b', 'c'].map(source => run(source));
  await settle();
  assert.deepEqual(calls.map(c => c.source), ['a'], 'only the primer starts while the shared view is cold');
  calls[0].answer();
  await settle();
  assert.deepEqual(calls.map(c => c.source), ['a', 'b', 'c'], 'the rest start together once the primer answers, before it finishes');
  calls.forEach(c => { c.answer(); c.finish(); });
  assert.deepEqual(await Promise.all(replies), ['summary of a', 'summary of b', 'summary of c']);
  const warm = run('d', view.replace('</chat>', 'user: one new line\n</chat>'));
  await settle();
  assert.equal(calls.length, 4, 'a newer view with the same cached prefix starts right away');
  calls[3].answer(); calls[3].finish();
  await warm;
});

test('a failing primer releases the waiting calls instead of hanging them', { timeout: 5000 }, async () => {
  const { calls, run, settle } = await setup();
  const replies = ['a', 'b', 'c'].map(source => run(source).catch((error: Error) => error.message));
  await settle();
  calls[0].fail();
  await settle();
  assert.equal(calls.length, 2, 'the next waiter primes in its place');
  calls[1].answer();
  await settle();
  calls.slice(1).forEach(c => { c.answer(); c.finish(); });
  assert.deepEqual(await Promise.all(replies), ['overloaded', 'summary of b', 'summary of c']);
});

test('a waiting call that is cancelled stops at once without ever calling the model', { timeout: 5000 }, async () => {
  const { calls, run, settle, view } = await setup();
  const primer = run('a'), cancel = new AbortController();
  const waiter = run('b', view, cancel.signal);
  await settle();
  cancel.abort();
  await assert.rejects(waiter, { name: 'AbortError' });
  calls[0].answer(); calls[0].finish();
  await primer;
  assert.deepEqual(calls.map(c => c.source), ['a']);
});
