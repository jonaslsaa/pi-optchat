import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createCompressor } from '../src/compactor.ts';

/** Actual Anthropic serialization/SSE against a local provider. Response starts and completions are independent. */
async function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-compactor-'));
  const calls: { source: string; answer: () => void; finish: () => void; fail: () => void }[] = [];
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (req.url?.includes('count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ input_tokens: 100000 })); return; }
    const source = body.messages.at(-1).content.map((b: { text?: string }) => b.text ?? '').join('').split('\n').at(-2) ?? '';
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders();
    const send = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    let answered = false;
    calls.push({ source, answer: () => {
      if (answered) return; answered = true;
      send('message_start', { message: { id: source, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, usage: { input_tokens: 100, output_tokens: 0 } } });
      send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
      send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: `summary of ${source}` } });
    }, finish: () => {
      send('content_block_stop', { index: 0 });
      send('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } }); send('message_stop', {}); res.end();
    }, fail: () => { send('error', { error: { type: 'overloaded_error', message: 'overloaded' } }); res.end(); } });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false });
  runtime.registerProvider('optchat-test', {
    baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, apiKey: 'synthetic', api: 'anthropic-messages',
    models: [{ id: 'claude-sonnet-5-5', name: 'Synthetic compactor', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 1000 }],
  });
  const compress = createCompressor(new ModelRegistry(runtime), () => ({ provider: 'optchat-test', model: 'claude-sonnet-5-5', thinking: 'off' }));
  // Long enough for a cache mark, so the first 50k characters are a shared, cacheable prefix.
  const view = `<chat>\n${'0+1|user: an old remembered line\n'.repeat(2000)}</chat>`;
  // The compactor only sees sources over NODE bytes; the fake model reads just the last line.
  const run = (source: string, context = view, signal = new AbortController().signal) => compress({ context, source: `${'x'.repeat(600)}\n${source}`, part: { l: 0, i: 0 } }, signal);
  const settle = async () => {
    const end = Date.now() + 5000;
    while (!calls.length) { if (Date.now() > end) throw new Error('No request'); await new Promise(resolve => setTimeout(resolve, 10)); }
    await new Promise(resolve => setTimeout(resolve, 80));
  };
  return { calls, run, settle, view };
}

test('parallel calls on a cold view wait until one call has started answering, and a warm view skips the wait', async t => {
  const { calls, run, settle, view } = await setup(t);
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

test('a call whose view runs past a cold prefix that is being primed waits for that primer', { timeout: 5000 }, async t => {
  const { calls, run, settle, view } = await setup(t);
  const longer = view.replace('</chat>', '0+1|user: a newer line\n'.repeat(4) + '</chat>');
  const replies = [run('a'), run('b', longer)];
  await settle();
  assert.deepEqual(calls.map(c => c.source), ['a'], 'the longer view waits for the shorter one being primed');
  calls[0].answer();
  await settle();
  assert.deepEqual(calls.map(c => c.source), ['a', 'b']);
  calls.forEach(c => { c.answer(); c.finish(); });
  await Promise.all(replies);
});

test('a failing primer releases the waiting calls instead of hanging them', { timeout: 5000 }, async t => {
  const { calls, run, settle } = await setup(t);
  const replies = ['a', 'b', 'c'].map(source => run(source).catch((error: Error) => error.message));
  await settle();
  calls[0].fail();
  await settle();
  assert.equal(calls.length, 2, 'the next waiter primes in its place');
  calls[1].answer();
  await settle();
  calls.slice(1).forEach(c => { c.answer(); c.finish(); });
  const results = await Promise.all(replies);
  assert.match(results[0], /overloaded/); assert.deepEqual(results.slice(1), ['summary of b', 'summary of c']);
});

test('a waiting call that is cancelled stops at once without ever calling the model', { timeout: 5000 }, async t => {
  const { calls, run, settle, view } = await setup(t);
  const primer = run('a'), cancel = new AbortController();
  const waiter = run('b', view, cancel.signal);
  await settle();
  cancel.abort();
  await assert.rejects(waiter, /abort/i);
  calls[0].answer(); calls[0].finish();
  await primer;
  assert.deepEqual(calls.map(c => c.source), ['a']);
});
