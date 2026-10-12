import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { CacheGate, cacheEligible, cacheMinimum, cachePlan, type CacheRoute } from '../src/cache-gate.ts';
import { cachePayload, splitView } from '../src/cache.ts';
const renderView = (lines: string[]) => `<chat>\n${lines.join('\n')}\n</chat>`;

const route: CacheRoute = { provider: 'anthropic', model: 'claude-sonnet-5-5', baseUrl: 'https://invalid.local', apiKey: 'one' };
const signal = () => new AbortController().signal;
const turn = () => new Promise(resolve => setImmediate(resolve));
function payload(lines: number, task = 'task', first = 'first') {
  const view = renderView(Array.from({ length: lines }, (_, i) => `${i}+1|${i === 0 ? first : 'summary'} ${'evidence '.repeat(20)}`));
  return cachePayload({ model: route.model, tools: [{ name: 'zoom', input_schema: { type: 'object' } }], system: [{ type: 'text', text: 'stable rules' }],
    messages: [{ role: 'user', content: [{ type: 'text', text: view }, { type: 'text', text: task }] }] }) as Record<string, any>;
}
const plan = (lines: number, task = 'task', first = 'first') => cachePlan(payload(lines, task, first), route);

test('zero through nine summaries have separate framing, complete four-summary blocks and valid final marks', () => {
  for (const n of [...Array.from({ length: 10 }, (_, i) => i), 80, 160, 5500]) {
    const view = renderView(Array.from({ length: n }, (_, i) => `${i}+1|summary quoting </chat> safely`)), pieces = splitView(view);
    assert.equal(pieces.join(''), view); assert.equal(pieces[0], '<chat>\n');
    assert.equal(pieces.length, Math.floor(n / 4) + 2);
    for (const block of pieces.slice(1, -1)) assert.equal(block.trimEnd().split('\n').length, 4);
    const marked = cachePayload({ system: [], tools: [], cache_control: { type: 'ephemeral', ttl: '1h' }, messages: [
      { role: 'user', content: [{ type: 'text', text: view }, { type: 'text', text: 'new message' }] }] }) as Record<string, any>;
    const blocks = marked.messages[0].content;
    const indices = blocks.flatMap((block: Record<string, unknown>, i: number) => block.cache_control ? [i] : []);
    assert.deepEqual(indices, [Math.floor(n / 4) - 40, Math.floor(n / 4) - 20, Math.floor(n / 4)].filter(i => i > 0));
    assert.deepEqual(marked.cache_control, { type: 'ephemeral' });
    assert.equal(blocks.map((b: { text: string }) => b.text).join(''), view + 'new message');
    assert.ok(indices.length <= 3);
    const extended = splitView(view.slice(0, -'</chat>'.length) + 'new+1|appended\n</chat>');
    assert.deepEqual(extended.slice(0, pieces.length - 1), pieces.slice(0, -1));
  }
});

test('both launch orders wait at a shared earlier explicit mark, not just the longest mark', async () => {
  for (const [a, b] of [[80, 160], [160, 80]]) {
    const gate = new CacheGate(async () => true);
    const release = await gate.acquire(plan(a, 'leader'), route, signal());
    let started = false;
    const follower = gate.acquire(plan(b, 'follower'), route, signal()).then(release => { started = true; return release; });
    await turn(); assert.equal(started, false, `${a} then ${b}`);
    release(true); (await follower)(true);
    assert.equal(started, true);
  }
});

test('both orders without a readable marked prefix and unrelated views stay concurrent', async () => {
  for (const [a, b] of [[80, 400], [400, 80]]) {
    const gate = new CacheGate(async () => { throw new Error('there is no shared write to count'); });
    const first = await gate.acquire(plan(a, 'one'), route, signal());
    const second = await gate.acquire(plan(b, 'two'), route, signal()); first(false); second(false);
  }
  const gate = new CacheGate(async () => { throw new Error('unrelated prefix'); });
  const first = await gate.acquire(plan(160), route, signal());
  const second = await gate.acquire(plan(160, 'two', 'different'), route, signal()); first(false); second(false);
});

test('the 20-position read window includes the marked position, and can read a shorter writer only within it', async () => {
  const short = plan(80, 'one');
  for (const [count, matches] of [[84, true], [156, true], [160, true], [400, false]] as const) {
    const long = plan(count, 'two');
    assert.equal(short.writes.some(write => long.reads.has(write.key)), matches, `${count} lines`);
  }
  const native = (blocks: number) => ({ model: route.model, messages: [{ role: 'user', content: Array.from({ length: blocks }, (_, i) => ({ type: 'text', text: String(i), ...i === blocks - 1 ? { cache_control: { type: 'ephemeral' } } : {} })) }] });
  const small = cachePlan(native(1), route).writes[0].key;
  assert.equal(cachePlan(native(20), route).reads.has(small), true);
  assert.equal(cachePlan(native(21), route).reads.has(small), false);
});

test('consecutive tool blocks count as one lookback position', () => {
  const content = [{ type: 'text', text: 'prior', cache_control: { type: 'ephemeral' } },
    ...Array.from({ length: 30 }, (_, i) => ({ type: 'tool_result', tool_use_id: String(i), content: 'ok' })), { type: 'text', text: 'next', cache_control: { type: 'ephemeral' } }];
  const both = cachePlan({ messages: [{ role: 'user', content }] }, route);
  delete (content[0] as { cache_control?: unknown }).cache_control;
  const endOnly = cachePlan({ messages: [{ role: 'user', content }] }, route);
  assert.ok(endOnly.reads.has(both.writes[0].key));
});

test('prompt, tools, effort, model, account and tenant changes create separate domains', async () => {
  const base = payload(160), first = cachePlan(base, route);
  const variants: [Record<string, any>, CacheRoute][] = [
    [{ ...base, system: [{ type: 'text', text: 'new rules' }] }, route],
    [{ ...base, tools: [{ name: 'zoom', strict: true, input_schema: { type: 'object' } }] }, route],
    [{ ...base, output_config: { effort: 'high' } }, route],
    [base, { ...route, model: 'claude-haiku-5-5' }], [base, { ...route, apiKey: 'two' }],
    [base, { ...route, headers: { 'x-tenant-id': 'other' } }], [base, { ...route, baseUrl: 'https://another.local' }],
  ];
  for (const [body, other] of variants) {
    const gate = new CacheGate(async () => { throw new Error('different domain must not wait'); });
    const release = await gate.acquire(first, route, signal());
    (await gate.acquire(cachePlan(body, other), other, signal()))(false); release(false);
  }
  assert.deepEqual(cachePlan(base, { ...route, headers: { 'x-session-id': 'different turn' } }).writes, first.writes, 'session affinity is not account identity');
});

test('ineligible shared marks never delay requests', async () => {
  let checked = 0;
  const gate = new CacheGate(async () => { checked++; return false; });
  const first = await gate.acquire(plan(160), route, signal());
  const second = await gate.acquire(plan(80), route, signal());
  assert.ok(checked > 0); first(false); second(false);
});

test('failed leaders, aborted waiters and aborted leaders release their leases', async () => {
  const gate = new CacheGate(async () => true), cancel = new AbortController();
  const first = await gate.acquire(plan(80), route, signal());
  const aborted = gate.acquire(plan(160), route, cancel.signal);
  await turn(); cancel.abort(); await assert.rejects(aborted, { name: 'AbortError' });
  let started = 0;
  const next = gate.acquire(plan(160, 'two'), route, signal()).then(release => { started++; return release; });
  const last = gate.acquire(plan(80, 'three'), route, signal()).then(release => { started++; return release; });
  await turn(); first(false); const second = await next; await turn(); assert.equal(started, 1);
  second(true); (await last)(true); assert.equal(started, 2);
  const cold = new CacheGate(async () => true), controller = new AbortController();
  await cold.acquire(plan(80), route, controller.signal);
  const following = cold.acquire(plan(160), route, signal()); await turn(); controller.abort(); (await following)(false);
});

test('warm reads stay concurrent, expire from request start, and stalled primers expire too', async () => {
  let now = 0;
  const gate = new CacheGate(async () => true, 100, () => now);
  const first = await gate.acquire(plan(80), route, signal()); now = 90; first(true);
  (await gate.acquire(plan(80, 'warm'), route, signal()))(false);
  now = 101;
  const second = await gate.acquire(plan(80, 'new primer'), route, signal());
  let started = false;
  const third = gate.acquire(plan(160), route, signal()).then(release => { started = true; return release; });
  await turn(); assert.equal(started, false);
  now = 202;
  const independent = await gate.acquire(plan(160, 'expired primer', 'different'), route, signal());
  (await third)(false); assert.equal(started, true); second(false); independent(false);
});

test('eligibility uses model-specific provider token counts, with a safe fallback for unknown or unsupported models', async () => {
  assert.equal(cacheMinimum('claude-sonnet-5-5'), 512);
  assert.equal(cacheMinimum('claude-haiku-4-5-20251001'), 4096);
  assert.equal(cacheMinimum('claude-opus-4-7'), 2048);
  assert.equal(cacheMinimum('claude-sonnet-4-6'), 1024);
  assert.equal(cacheMinimum('claude-opus-4-999'), undefined);
  let tokens = 511, status = 200, calls = 0;
  const server = createServer(async (req, res) => {
    calls++; assert.equal(req.url, '/v1/messages/count_tokens'); assert.equal(req.headers['x-api-key'], 'one');
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()); assert.equal(body.model, route.model);
    assert.ok(!JSON.stringify(body).includes('cache_control'));
    res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ input_tokens: tokens }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const local = { ...route, baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}` }, boundary = plan(160).writes[0];
  try {
    assert.equal(await cacheEligible(boundary, local, signal()), false);
    tokens = 512; assert.equal(await cacheEligible(boundary, local, signal()), true);
    status = 404; assert.equal(await cacheEligible(boundary, local, signal()), false);
    assert.equal(await cacheEligible(boundary, { ...local, model: 'unknown' }, signal()), false); assert.equal(calls, 3);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(cacheEligible(boundary, local, controller.signal), { name: 'AbortError' });
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
