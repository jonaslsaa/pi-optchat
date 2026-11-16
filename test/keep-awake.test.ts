import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionUIContext, type Theme } from '@earendil-works/pi-coding-agent';
import type { Component } from '@earendil-works/pi-tui';
import optchat from '../src/index.ts';
import { AWAKE_GRACE, keepAwake } from '../src/keep-awake.ts';
import { createProfile, loadConfig, profilePath, saveConfig } from '../src/profiles.ts';
import { SETTING_KEYS } from '../src/settings.ts';
import { COMPACT } from '../src/core/prompts.ts';
import { REPORT_TYPE, textContent } from '../src/transcript.ts';
import { emptyUsage } from '../src/usage.ts';
import { removeDir } from './support.ts';

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'optchat-agent-'));
const plain = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;
async function until(condition: () => boolean) {
  const deadline = Date.now() + 10000;
  while (!condition()) { if (Date.now() > deadline) throw new Error('Timed out'); await new Promise(r => setTimeout(r, 10)); }
}

/** A fake `caffeinate`: records how it was started and whether it was killed. */
function fakes() {
  const started: { args: string[]; killed: boolean; child: EventEmitter }[] = [];
  const start = (args: string[]) => {
    const child = new EventEmitter(), entry = { args, killed: false, child };
    started.push(entry);
    return Object.assign(child, { kill: () => { entry.killed = true; } });
  };
  return { started, start };
}

test('one caffeinate holds a Mac awake across back-to-back runs and lets go a grace period after the last', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { started, start } = fakes(), awake = keepAwake({ start, platform: 'darwin', pid: 4242 });
  awake.update(true, true);
  assert.deepEqual(started.map(s => s.args), [['-i', '-w', '4242']], 'tied to the owner, so it ends if Pi dies');
  awake.update(false, true);
  t.mock.timers.tick(AWAKE_GRACE - 1);
  awake.update(true, true); awake.update(true, true);
  assert.equal(started.length, 1, 'a run inside the grace period and repeated updates share the hold');
  awake.update(false, true);
  t.mock.timers.tick(AWAKE_GRACE - 1);
  assert.equal(started[0].killed, false, 'the grace period starts again from the last run');
  t.mock.timers.tick(1);
  assert.equal(started[0].killed, true);
});

test('turning the setting off lets go at once, even mid-run', () => {
  const { started, start } = fakes(), awake = keepAwake({ start, platform: 'darwin' });
  awake.update(true, true); awake.update(true, false);
  assert.equal(started[0].killed, true);
  awake.update(true, false);
  assert.equal(started.length, 1, 'and stays off');
});

test('off macOS nothing is started', () => {
  const { started, start } = fakes();
  keepAwake({ start, platform: 'linux' }).update(true, true);
  assert.equal(started.length, 0);
});

test('a caffeinate that exits or fails to start is replaced on the next busy update', () => {
  const { started, start } = fakes(), awake = keepAwake({ start, platform: 'darwin' });
  awake.update(true, true); started[0].child.emit('exit');
  awake.update(true, true); started[1].child.emit('error');
  awake.update(true, true);
  assert.equal(started.length, 3);
});

test('Pi holds the Mac awake while the main agent or a subagent works, and lets go when the setting is turned off', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-awake-'));
  const oldHome = process.env.OPTCHAT_HOME;
  process.env.OPTCHAT_HOME = dir;
  const updates: [busy: boolean, enabled: boolean][] = [];
  const awake = { update: (busy: boolean, enabled: boolean) => { updates.push([busy, enabled]); }, release: () => {} };
  const last = () => updates.at(-1);
  let releaseMain!: () => void, releaseChild!: () => void;
  const main = new Promise<void>(resolve => { releaseMain = resolve; }), child = new Promise<void>(resolve => { releaseChild = resolve; });
  let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined;
  try {
    createProfile('fixture');
    const fixture = { provider: 'fixture', model: 'fixture', thinking: 'off' } as const;
    saveConfig(profilePath('fixture'), { ...loadConfig(profilePath('fixture')), compactor: fixture, subagent: fixture });
    const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false });
    const seen: (typeof updates[number] | undefined)[] = [];
    runtime.registerProvider('fixture', {
      baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
      models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
      streamSimple(model, context) {
        const compression = context.messages.some(m => m.role === 'system' && m.content === COMPACT), text = textContent(context.messages.at(-1)?.content);
        const reply: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: compression ? 'Summary.' : 'Done.' }],
          timestamp: Date.now(), stopReason: 'stop', api: model.api, provider: model.provider, model: model.id, usage: emptyUsage() };
        if (!compression && text.endsWith('Spawn one.')) {
          reply.stopReason = 'toolUse';
          reply.content = [{ type: 'toolCall', id: 'spawn-1', name: 'spawn', arguments: { tasks: [{ task: 'child task' }] } }];
        }
        const stream = createAssistantMessageEventStream();
        void (async () => {
          if (!compression && text.endsWith('Long task.')) { seen.push(last()); await main; }
          if (!compression && text.endsWith('child task')) await child;
          stream.push({ type: 'done', reason: reply.stopReason === 'toolUse' ? 'toolUse' : 'stop', message: reply }); stream.end();
        })();
        return stream;
      },
    });
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } });
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, 'agent'), settingsManager,
      noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, extensionFactories: [pi => optchat(pi, { awake })] });
    await loader.reload();
    const manager = SessionManager.inMemory(dir);
    manager.appendCustomEntry('optchat.profile', { name: 'fixture' });
    session = (await createAgentSession({ modelRuntime: runtime, model: runtime.getModel('fixture', 'fixture'), resourceLoader: loader, settingsManager, sessionManager: manager, tools: ['zoom', 'spawn'] })).session;
    // The settings page, driven by keys: down past the two model rows to Keep Mac awake, the last setting, toggle it, close.
    const custom = (async (factory: (tui: unknown, theme: Theme, keys: unknown, done: (result: undefined) => void) => Component) => {
      const page = factory({ requestRender: () => {} }, plain, {}, () => {});
      for (const key of [...Array(SETTING_KEYS.indexOf('keepAwake') + 2).fill('\x1b[B'), ' ', '\x1b']) page.handleInput?.(key);
    }) as unknown as ExtensionUIContext['custom'];
    await session.bindExtensions({ uiContext: { ...session.extensionRunner.getUIContext(), custom }, mode: 'tui' });

    const running = session.prompt('Long task.');
    await until(() => seen.length === 1);
    assert.deepEqual(seen[0], [true, true], 'on by default, held during the main turn');
    releaseMain(); await running;
    assert.deepEqual(last(), [false, true]);

    await session.prompt('Spawn one.');
    await until(() => last()?.[0] === true);
    assert.equal(session.isStreaming, false, 'the main agent is idle; its subagent holds the Mac awake');
    releaseChild();
    // The child's report wakes the main agent for a turn of its own; once that settles, nothing works.
    await until(() => !!session?.messages.some(m => m.role === 'custom' && m.customType === REPORT_TYPE) && !session.isStreaming);
    await session.agent.waitForIdle();
    assert.deepEqual(last(), [false, true]);

    // Pi runs a prompt sent while its last turn's settle handlers still run once they finish.
    await session.prompt('/optchat settings');
    await until(() => !loadConfig(profilePath('fixture')).keepAwake);
    assert.deepEqual(last(), [false, false], 'turning it off reaches the hold at once');
  } finally {
    releaseMain(); releaseChild();
    if (session) { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); }
    if (oldHome === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = oldHome;
    removeDir(dir);
  }
});
