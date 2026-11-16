import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { createAgentSession, ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { Children } from '../src/agents.ts';
import { createCompressor } from '../src/compactor.ts';
import { createHandoffSummarizer } from '../src/handoff.ts';
import { readLimits } from '../src/files.ts';
import { limitsFrom, noteLimits, noteRefusal } from '../src/limits.ts';
import { Memory } from '../src/memory.ts';
import { emptyUsage } from '../src/usage.ts';

// Children load installed extensions from Pi's agent dir; keep tests away from the user's real one.
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'optchat-agent-'));

/** The headers of a real answer of Anthropic's to a subscription's login through Pi 1.5.2, without the ones that say nothing here. */
const HEADERS = {
  'anthropic-ratelimit-unified-5h-reset': '1794846600', 'anthropic-ratelimit-unified-5h-status': 'rejected', 'anthropic-ratelimit-unified-5h-utilization': '1.01',
  'anthropic-ratelimit-unified-7d-reset': '1795147200', 'anthropic-ratelimit-unified-7d-status': 'allowed', 'anthropic-ratelimit-unified-7d-utilization': '0.4',
  'anthropic-ratelimit-unified-overage-in-use': 'true', 'anthropic-ratelimit-unified-overage-status': 'allowed', 'anthropic-ratelimit-unified-overage-utilization': '0.0',
  'anthropic-ratelimit-unified-representative-claim': 'five_hour', 'anthropic-ratelimit-unified-reset': '1794846600', 'anthropic-ratelimit-unified-status': 'rejected',
  'content-type': 'text/event-stream', 'request-id': 'req_1',
};
const NOW = Date.UTC(2026, 10, 16, 13, 12, 51), AT = '2026-11-16T13:12:51.000Z';
const SAVED = { at: AT, overage: true, limits: [
  { window: '5h', used: 1.01, resets: '2026-11-16T16:30:00.000Z', reached: true },
  { window: '7d', used: 0.4, resets: '2026-11-20T04:00:00.000Z', reached: false },
] };
const RATE_LIMITED = '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}';

test('a subscription\'s limits are read from an answer\'s headers, saved whole, and read back by an app; other headers save nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-limits-'));
  assert.equal(readLimits(dir), undefined, 'none yet');
  // An API key's answer, and another provider's, name no limits.
  noteLimits(dir, { 'content-type': 'text/event-stream', 'anthropic-ratelimit-requests-remaining': '49', 'x-ratelimit-remaining-tokens': '1000' }, NOW);
  assert.deepEqual(readdirSync(dir), []);
  noteLimits(dir, HEADERS, NOW);
  assert.deepEqual(readLimits(dir), SAVED);
  assert.deepEqual(readdirSync(dir), ['limits.json'], 'reading writes nothing, and no temporary file is left');
  // A window the provider did not count, or counted in words, is left out; the other stays.
  const { 'anthropic-ratelimit-unified-7d-reset': _, ...partial } = HEADERS;
  assert.deepEqual(limitsFrom({ ...partial, 'anthropic-ratelimit-unified-overage-in-use': 'false' }, NOW), { at: AT, overage: false, limits: [SAVED.limits[0]] });
  assert.equal(limitsFrom({ ...HEADERS, 'anthropic-ratelimit-unified-5h-utilization': 'high', 'anthropic-ratelimit-unified-7d-utilization': '' }, NOW), undefined);
  // What is not a snapshot is none: an app shows "no data yet", not an error.
  for (const text of ['', '{"at":"2026', JSON.stringify({ ...SAVED, limits: [{ ...SAVED.limits[0], window: '1h' }] }), JSON.stringify({ ...SAVED, at: 'yesterday' })]) {
    writeFileSync(join(dir, 'limits.json'), text);
    assert.equal(readLimits(dir), undefined, text);
  }
});

test('a request the provider turns away for a rate limit is noted with the windows as they were, and the next good answer clears it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-limits-'));
  noteRefusal(dir, '500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}', NOW);
  noteRefusal(dir, undefined, NOW);
  // Nor is a rate limit with no limits saved: an API key's, which no later answer would clear.
  noteRefusal(dir, RATE_LIMITED, NOW);
  assert.equal(existsSync(join(dir, 'limits.json')), false, 'another error is not a refusal, and nothing is noted where no limits are saved');
  noteLimits(dir, HEADERS, NOW);
  noteRefusal(dir, RATE_LIMITED, NOW + 60_000);
  assert.deepEqual(readLimits(dir), { ...SAVED, refused: '2026-11-16T13:13:51.000Z' });
  noteLimits(dir, HEADERS, NOW + 120_000);
  assert.deepEqual(readLimits(dir), { ...SAVED, at: '2026-11-16T13:14:51.000Z' });
});

/** A provider whose answers come with HEADERS, as Pi's own providers hand them over, and end in `error` when one is given. */
async function provider(dir: string, error?: string) {
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false });
  runtime.registerProvider('optchat-test', {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'anthropic-messages',
    models: [{ id: 'model', name: 'Synthetic', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 1000 }],
    streamSimple(model, _context, options) {
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'done' }], api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
        stopReason: error ? 'error' : 'stop', ...error && { errorMessage: error }, usage: emptyUsage() };
      void (async () => {
        if (error) stream.push({ type: 'error', reason: 'error', error: message });
        else { await options?.onResponse?.({ status: 200, headers: HEADERS }, model); stream.push({ type: 'start', partial: message }); stream.push({ type: 'done', reason: 'stop', message }); }
        stream.end();
      })();
      return stream;
    },
  });
  return runtime;
}
const choice = () => ({ provider: 'optchat-test', model: 'model', thinking: 'off' as const });

/** What `ask` leaves in a profile's folder: with answers that come with HEADERS, and then, on those limits, with ones that are refused. */
async function saves(ask: (registry: ModelRegistry, dir: string, runtime: ModelRuntime) => Promise<unknown>) {
  const asked = async (dir: string, error?: string) => { const runtime = await provider(dir, error); return ask(new ModelRegistry(runtime), dir, runtime); };
  const dir = mkdtempSync(join(tmpdir(), 'optchat-limits-'));
  await asked(dir);
  const { at, ...counted } = readLimits(dir) ?? {};
  assert.deepEqual(counted, { limits: SAVED.limits, overage: true });
  await asked(dir, RATE_LIMITED).catch(() => {});
  const noted = readLimits(dir);
  assert.deepEqual({ ...noted, refused: undefined }, { at, ...counted, refused: undefined }, 'the windows are as they were');
  assert.ok(noted?.refused, 'the refusal is noted');
}

test('the compactor\'s answers keep the limits too, for the chat\'s summaries and an import\'s alike', () =>
  saves((registry, dir) => createCompressor(registry, choice, { limits: dir, retryDelays: [] })({ context: '<chat>\n0+1|user: a line\n</chat>', source: 'x'.repeat(700), part: { l: 0, i: 0 }, images: [] }, new AbortController().signal)));

test('so do the answers that summarize a connected window\'s handoff', () =>
  saves((registry, dir) => createHandoffSummarizer(registry, choice, () => {}, [], dir)({ id: 'a1', task: 'Task', cwd: dir, model: 'optchat-test/model', thinking: 'off', parentSession: 'main', started: 0, depth: 1, state: 'completed', guidance: [] }, [])));

test('and a subagent\'s, which runs in a session of its own without pi-optchat', () =>
  saves(async (registry, dir, runtime) => {
    const refused = !!readLimits(dir);
    const children = new Children(new Memory(dir, async input => input.source.slice(0, 100), () => {}), registry, choice, () => '', async () => {}, () => {}, dir,
      { limits: dir, createSession: options => createAgentSession({ ...options, modelRuntime: runtime }) });
    try {
      await children.spawn([{ task: 'anything' }], dir);
      // Pi asks again after a rate limit, so the child is still at work when its first refusal is in.
      const deadline = Date.now() + 10_000;
      while (refused ? !readLimits(dir)?.refused : !readLimits(dir) || children.active) { if (Date.now() > deadline) throw new Error('Timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
    } finally { await children.close(); }
  }));
