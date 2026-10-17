import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Model } from '@earendil-works/pi-ai';
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript';
import { convertToLlm } from '@earendil-works/pi-coding-agent';
import { stream as anthropic } from '@earendil-works/pi-ai/api/anthropic-messages';
import { stream as responses } from '@earendil-works/pi-ai/api/openai-responses';
import { stream as completions } from '@earendil-works/pi-ai/api/openai-completions';
import { Guidance, type GuidanceState } from '../src/guidance.ts';
import { cachePayload, record } from '../src/cache.ts';
import { removeDir } from './support.ts';

for (const api of ['anthropic-messages', 'openai-responses', 'openai-completions'] as const) {
  test(`${api}: actual adapter payload keeps guidance before changing memory and the transition after work`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'optchat-guidance-wire-')), cwd = join(dir, 'project'), profile = join(dir, 'profile');
    mkdirSync(cwd); mkdirSync(profile); const source = join(cwd, 'AGENTS.md'); writeFileSync(source, 'Use SQLite.');
    const guidance = new Guidance(profile); let state: GuidanceState | undefined;
    const model: Model<typeof api> = { api, provider: api === 'anthropic-messages' ? 'anthropic' : 'openai', id: 'fixture', name: 'Fixture',
      baseUrl: 'https://invalid.local', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 20 };
    async function capture(memory: string) {
      const base: AgentMessage[] = [{ role: 'system', content: 'STABLE_INSTRUCTIONS', timestamp: 0 },
        { role: 'user', content: [{ type: 'text', text: `<chat>\n0+1|memory\n1+1|more\n2+1|more\n3+1|more\n${memory}\n</chat>` }, { type: 'text', text: '\n\nRECENT_WORK' }], timestamp: 1 }];
      const prepared = guidance.prepare(base, cwd, state, s => { state = s; }, join(dir, 'agent'));
      let payload: unknown;
      const options = { apiKey: 'synthetic', maxTokens: 20,
        onPayload(value: unknown) { payload = structuredClone(api === 'anthropic-messages' ? cachePayload(value) : value); throw new Error('Captured before network'); },
        fetch: (() => { throw new Error('Unexpected network request'); }) as typeof fetch };
      const context = normalizeContext({ messages: convertToLlm(prepared.messages) });
      const stream = api === 'anthropic-messages' ? anthropic(model as Model<'anthropic-messages'>, context, options)
        : api === 'openai-responses' ? responses(model as Model<'openai-responses'>, context, options)
        : completions(model as Model<'openai-completions'>, context, options);
      const result = await stream.result();
      assert.match(result.errorMessage ?? '', /Captured before network/);
      assert.ok(record(payload)); return payload;
    }
    try {
      const first = await capture('view one');
      const unchanged = await capture('view two');
      const head = (payload: Record<string, unknown>) => api === 'anthropic-messages' ? JSON.stringify(payload.system)
        : JSON.stringify((api === 'openai-responses' ? payload.input : payload.messages as unknown[]) && ((api === 'openai-responses' ? payload.input : payload.messages) as unknown[])[0]);
      assert.equal(head(first), head(unchanged), 'changing memory leaves the guidance prefix byte-identical');
      utimesSync(source, new Date(), new Date(Date.now() + 10000));
      assert.deepEqual(await capture('view two'), unchanged, 'touching guidance produces an identical provider payload');
      writeFileSync(source, 'Use PostgreSQL.');
      const changed = await capture('view three'), serialized = JSON.stringify(changed);
      assert.match(head(changed), /Use PostgreSQL/); assert.doesNotMatch(head(changed), /Use SQLite/);
      assert.ok(head(changed).indexOf('STABLE_INSTRUCTIONS') < head(changed).indexOf('Use PostgreSQL'));
      const ordered = head(changed) + JSON.stringify(api === 'openai-responses' ? changed.input : changed.messages);
      assert.ok(ordered.indexOf('Use PostgreSQL') < ordered.indexOf('<chat>'));
      assert.ok(serialized.indexOf('RECENT_WORK') < serialized.indexOf('<guidance_update>'));
      assert.equal(serialized.split('<guidance_update>').length - 1, 1);
      if (api === 'anthropic-messages') {
        assert.ok(JSON.stringify(changed.messages).includes('cache_control'));
        assert.deepEqual(changed.cache_control, { type: 'ephemeral' });
        assert.doesNotMatch(head(changed), /cache_control/, 'existing OptChat view cache marks are preserved');
      }
    } finally { removeDir(dir); }
  });
}
