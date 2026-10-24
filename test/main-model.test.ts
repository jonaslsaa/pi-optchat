import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import optchat from '../src/index.ts';
import { createProfile, loadConfig, profilePath, saveConfig } from '../src/profiles.ts';
import type { ModelChoice } from '../src/compactor.ts';
import { removeDir } from './support.ts';

const model = (id: string, reasoning: boolean) =>
  ({ id, name: id, reasoning, input: ['text' as const], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 });

/** Opens the `fixture` profile in a Pi session that starts on fixture/plain, as Pi's global default would pick it. */
async function open(dir: string, main: ModelChoice | undefined, sessions: { close: () => Promise<void> }[]) {
  const profile = profilePath('fixture'), fixture = { provider: 'fixture', model: 'plain', thinking: 'off' as const };
  saveConfig(profile, { ...loadConfig(profile), compactor: fixture, subagent: fixture, ...main && { main } });
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models-cache.json'), refreshOnCreate: false });
  runtime.registerProvider('fixture', { baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions', models: [model('plain', false), model('deep', true)] });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, 'agent'), settingsManager,
    noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, extensionFactories: [optchat] });
  await loader.reload();
  const manager = SessionManager.create(dir, join(dir, 'sessions'));
  manager.appendCustomEntry('optchat.profile', { name: 'fixture' });
  const { session } = await createAgentSession({ modelRuntime: runtime, model: runtime.getModel('fixture', 'plain'), resourceLoader: loader, settingsManager, sessionManager: manager });
  const notes: string[] = [];
  await session.bindExtensions({ uiContext: { ...session.extensionRunner.getUIContext(), notify: text => { notes.push(text); } }, mode: 'print' });
  const opened = { session, runtime, notes, saved: () => loadConfig(profile).main,
    close: async () => { sessions.splice(sessions.indexOf(opened), 1); await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); } };
  sessions.push(opened);
  return opened;
}

test('the main model and thinking level follow the profile', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-main-model-'));
  const oldHome = process.env.OPTCHAT_HOME;
  process.env.OPTCHAT_HOME = join(dir, 'home');
  const sessions: { close: () => Promise<void> }[] = [];
  try {
    createProfile('fixture');
    const first = await open(dir, undefined, sessions);
    assert.equal(first.session.model?.id, 'plain', 'nothing saved yet: Pi keeps its own pick');
    await first.session.setModel(first.runtime.getModel('fixture', 'deep')!);
    first.session.setThinkingLevel('low');
    assert.deepEqual(first.saved(), { provider: 'fixture', model: 'deep', thinking: 'low' });
    await first.close();

    const second = await open(dir, first.saved(), sessions);
    assert.equal(second.session.model?.id, 'deep', 'reopening picks the saved model over Pi\'s default');
    assert.equal(second.session.thinkingLevel, 'low');
    assert.deepEqual(second.saved(), { provider: 'fixture', model: 'deep', thinking: 'low' }, 'reopening leaves the saved choice as it was');
    assert.deepEqual(second.notes.filter(n => n.includes('main model')), []);
    await second.close();

    const gone = await open(dir, { provider: 'fixture', model: 'retired', thinking: 'high' }, sessions);
    assert.equal(gone.session.model?.id, 'plain', 'a model that no longer exists leaves Pi\'s pick alone');
    assert.deepEqual(gone.notes.filter(n => n.includes('main model')), ['fixture\'s main model fixture/retired is unavailable; keeping fixture/plain.']);
    await gone.close();
  } finally {
    for (const session of [...sessions]) await session.close();
    if (oldHome === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = oldHome;
    removeDir(dir);
  }
});
