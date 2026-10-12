import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type } from 'typebox';
import { createAssistantMessageEventStream, type AssistantMessage, type Context } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRegistry, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import optchat from '../src/index.ts';
import { createProfile, defaults, loadConfig, profilePath, saveConfig } from '../src/profiles.ts';
import { describeChoice } from '../src/compactor.ts';
import { contextPolicy, REPORT_TYPE, textContent } from '../src/transcript.ts';
import { commonPrompt } from '../src/prefix.ts';
import { emptyUsage } from '../src/usage.ts';
import { isCompaction } from './request-fixture.ts';
import { removeDir } from './support.ts';

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'oc-base-')), oldHome = process.env.OPTCHAT_HOME, oldRefresh = process.env.OPTCHAT_REFRESH_AT;
  process.env.OPTCHAT_HOME = dir; delete process.env.OPTCHAT_REFRESH_AT;
  const captured: Context[] = [], notices: string[] = [];
  let failed = false, summaries = 0;
  let mainReply: (context: Context) => Promise<AssistantMessage['content']> = async () => [{ type: 'text', text: 'Done.' }];
  createProfile('fixture'); const profile = profilePath('fixture');
  saveConfig(profile, { ...loadConfig(profile), compactor: { provider: 'fixture', model: 'fixture', thinking: 'off' } });
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false });
  runtime.registerProvider('fixture', { baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
    models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 1000 }],
    streamSimple(model, context) {
      const compression = isCompaction(context), fail = compression && failed;
      if (compression) summaries++; else captured.push(structuredClone(context));
      const stream = createAssistantMessageEventStream();
      queueMicrotask(async () => {
        const content = compression ? [{ type: 'text' as const, text: 'Summary.' }] : await mainReply(context);
        const message: AssistantMessage = { role: 'assistant', content, api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), usage: emptyUsage(),
          stopReason: fail ? 'error' : content.some(c => c.type === 'toolCall') ? 'toolUse' : 'stop', ...fail ? { errorMessage: 'fixture compactor unavailable' } : {} };
        if (fail) stream.push({ type: 'error', reason: 'error', error: message });
        else stream.push({ type: 'done', reason: message.stopReason === 'toolUse' ? 'toolUse' : 'stop', message });
        stream.end();
      });
      return stream;
    } });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, 'agent'), settingsManager, noExtensions: true, noSkills: true, noContextFiles: true,
    extensionFactories: [optchat, pi => { pi.registerTool({ name: 'step', label: 'Step', description: 'Fixture work', parameters: Type.Object({ n: Type.Number() }),
      execute: async (_id, { n }) => ({ content: [{ type: 'text', text: `TOOL-RESULT-${n} ${'evidence '.repeat(300)}` }], details: {} }) }); }] });
  await loader.reload();
  const manager = SessionManager.create(dir, join(dir, 'sessions')); manager.appendCustomEntry('optchat.profile', { name: 'fixture' });
  const { session } = await createAgentSession({ cwd: dir, modelRuntime: runtime, model: runtime.getModel('fixture', 'fixture'), resourceLoader: loader, settingsManager, sessionManager: manager, tools: ['step'] });
  await session.bindExtensions({ mode: 'print', uiContext: { ...session.extensionRunner.getUIContext(), notify: text => { notices.push(text); } } });
  return { session, captured, notices, runtime, profile, replies: (reply: typeof mainReply) => { mainReply = reply; }, fail: (value: boolean) => { failed = value; }, summaries: () => summaries,
    log: () => readdirSync(join(profile, 'main')).flatMap(file => readFileSync(join(profile, 'main', file), 'utf8').trim().split('\n').map(line => JSON.parse(line))),
    close: async () => {
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); process.env.OPTCHAT_HOME = oldHome;
      if (oldRefresh === undefined) delete process.env.OPTCHAT_REFRESH_AT; else process.env.OPTCHAT_REFRESH_AT = oldRefresh; removeDir(dir);
    } };
}

test('base turns freeze prior history and retain the entire long tool loop, steering and reports once', async () => {
  const f = await fixture(); let step = 0;
  try {
    f.replies(async context => {
      if (textContent(context.messages.at(-1)?.content).includes('NEXT-TURN')) return [{ type: 'text', text: 'New answer.' }];
      step++;
      if (step === 2) await f.session.steer('MID-TURN-STEERING');
      if (step === 3) await f.session.sendCustomMessage({ customType: REPORT_TYPE, content: '[abc123] LIVE-REPORT', display: true }, { triggerTurn: true, deliverAs: 'steer' });
      return step <= 5 ? [{ type: 'toolCall', id: `s${step}`, name: 'step', arguments: { n: step } }] : [{ type: 'text', text: 'Finished first turn.' }];
    });
    await f.session.prompt('ORIGINAL-TASK');
    assert.equal(f.captured.length, 6);
    const histories = f.captured.map(c => textContent(c.messages.find(m => m.role === 'user')?.content).split('</chat>')[0]);
    assert.equal(new Set(histories).size, 1, 'the initial view stays fixed even beyond the synthetic model window');
    const final = f.captured.at(-1)!.messages.filter(m => m.role !== 'system');
    assert.equal(final.filter(m => m.role === 'toolResult').length, 5);
    for (let i = 1; i <= 5; i++) assert.ok(final.some(m => m.role === 'toolResult' && textContent(m.content).includes(`TOOL-RESULT-${i}`)), JSON.stringify(final.filter(m => m.role === 'toolResult')));
    const users = final.filter(m => m.role === 'user').map(m => textContent(m.content)).join('\n');
    for (const marker of ['ORIGINAL-TASK', 'MID-TURN-STEERING', 'LIVE-REPORT']) assert.equal(users.split(marker).length - 1, 1, marker);
    assert.ok(!f.notices.some(n => n.includes('moved') && n.includes('into memory')));
    await f.session.prompt('NEXT-TURN');
    const next = f.captured.at(-1)!.messages.filter(m => m.role !== 'system');
    assert.deepEqual(next.map(m => m.role), ['user']);
    assert.ok(textContent(next[0].content).endsWith('NEXT-TURN'));
    assert.ok(!textContent(next[0].content).split('</chat>').at(-1)!.includes('ORIGINAL-TASK'));
    const log = f.log();
    for (const marker of ['ORIGINAL-TASK', 'MID-TURN-STEERING', '[abc123] LIVE-REPORT']) assert.equal(log.filter(e => e.text === marker).length, 1);
  } finally { await f.close(); }
});

test('failed prior summaries block the provider, remain dormant, and retry on the next user input without duplicates', async () => {
  const f = await fixture();
  try {
    f.fail(true);
    await f.session.prompt('PRIOR ' + 'evidence '.repeat(100));
    await new Promise(resolve => setImmediate(resolve));
    await f.session.prompt('BLOCKED-INPUT');
    assert.equal(f.captured.length, 1, 'no main request with incomplete history');
    assert.ok(f.notices.some(n => /summaries failed.*fixture compactor unavailable.*send another message/.test(n)));
    const attempts = f.summaries(); await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(f.summaries(), attempts, 'logging the failed turn does not immediately retry that same turn');
    f.fail(false); await f.session.prompt('RETRY-INPUT');
    assert.equal(f.captured.length, 2);
    const view = textContent(f.captured.at(-1)!.messages.find(m => m.role === 'user')?.content).split('</chat>')[0];
    assert.ok(!view.includes('(not summarized yet: zoom it)'));
    for (const input of ['BLOCKED-INPUT', 'RETRY-INPUT']) assert.equal(f.log().filter(e => e.text === input).length, 1);
    assert.ok(f.summaries() > attempts);
  } finally { await f.close(); }
});

test('effective defaults, environment overrides and model effort are represented honestly', async () => {
  const f = await fixture();
  try {
    assert.equal(defaults.previousExchange, false); assert.equal(defaults.refreshAt, 0); assert.equal(defaults.summaryAcceptBytes, 512);
    assert.deepEqual(defaults.compactor, { provider: 'anthropic', model: 'claude-haiku-4-5', thinking: 'xhigh' });
    assert.match(contextPolicy(defaults, '0.3'), /view only; turn refresh: 30% \(optional\) \(OPTCHAT_REFRESH_AT override\)/);
    assert.match(contextPolicy({ ...defaults, previousExchange: true, refreshAt: 0.4 }, '0'), /previous exchange replay \(optional\); turn refresh: off \(OPTCHAT_REFRESH_AT override\)/);
    const registry = new ModelRegistry(f.runtime);
    assert.match(describeChoice(registry, defaults.compactor), /xhigh requested; using high/);
    assert.match(describeChoice(registry, { ...defaults.compactor, model: 'missing-model' }), /model unavailable/);
    assert.match(f.notices.join('\n'), /Continuity: view only; turn refresh: off/);
    const prompt = commonPrompt();
    assert.match(prompt, /Use subagents only when the user asks for them/);
    assert.match(prompt, /Use the space up to the limit, and give it by value/);
    assert.match(prompt, /Keep them close to verbatim, however short/);
    assert.doesNotMatch(prompt, /bare\s+approval|start a subagent to watch|ceiling, not a target/);
  } finally { await f.close(); }
});
