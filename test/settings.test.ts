import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAssistantMessageEventStream, type AssistantMessage, type Context } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRegistry, ModelRuntime, SessionManager, SettingsManager, type Theme } from '@earendil-works/pi-coding-agent';
import optchat from '../src/index.ts';
import { Children } from '../src/agents.ts';
import { Memory } from '../src/memory.ts';
import { createProfile, defaults, loadConfig, profilePath, saveConfig, type ProfileConfig } from '../src/profiles.ts';
import { settingsPage } from '../src/settings-page.ts';
import { COMPACT } from '../src/prompts.ts';
import { textContent } from '../src/transcript.ts';
import { emptyUsage } from '../src/usage.ts';

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'optchat-agent-'));
const model = { provider: 'fixture', model: 'fixture', thinking: 'off' } as const;

async function until(condition: () => boolean) {
  const deadline = Date.now() + 10000;
  while (!condition()) { if (Date.now() > deadline) throw new Error('Timed out'); await new Promise(r => setTimeout(r, 10)); }
}
/** A provider whose first reply to a `hold …` task waits until the test releases it or the agent stops. */
async function fixture(dir: string, reply: (context: Context) => string = () => 'done') {
  const releases = new Map<string, () => void>();
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false });
  runtime.registerProvider('fixture', {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
    models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple(m, context, options) {
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: reply(context) }], api: m.api, provider: m.provider, model: m.id,
        timestamp: Date.now(), stopReason: 'stop', usage: emptyUsage() };
      const task = textContent(context.messages.find(x => x.role === 'user')?.content).split('Your task:\n').at(-1) ?? '';
      void (async () => {
        if (task.startsWith('hold') && context.messages.filter(x => x.role === 'user').length === 1) await new Promise<void>(resolve => { releases.set(task, resolve); options?.signal?.addEventListener('abort', () => resolve(), { once: true }); });
        stream.push({ type: 'done', reason: 'stop', message }); stream.end();
      })();
      return stream;
    },
  });
  return { runtime, releases };
}
async function children(dir: string, settings?: () => Pick<ProfileConfig, 'subagentLevels' | 'maxAgents'>) {
  const { runtime, releases } = await fixture(dir);
  const memory = new Memory(join(dir, 'memory'), async input => input.source.slice(0, 100), () => {});
  const made = new Children(memory, new ModelRegistry(runtime), () => model, () => '', async () => {}, () => {}, dir,
    { settings, createSession: options => createAgentSession({ ...options, modelRuntime: runtime }) });
  return { children: made, releases, close: async () => { for (const release of releases.values()) release(); await made.close(); await memory.close(); } };
}

test('a config.json from before settings existed loads with the defaults, and settings round-trip', () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-config-'));
  try {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ compactor: defaults.compactor, subagent: defaults.subagent }));
    assert.deepEqual(loadConfig(dir), { ...defaults, subagentLevels: 1, maxAgents: 8, previousExchange: true, previousExchangeKB: 16, summaryAcceptBytes: 640 });
    const changed = { ...loadConfig(dir), subagentLevels: 3, maxAgents: 12, previousExchange: false, previousExchangeKB: 4, summaryAcceptBytes: 512 };
    saveConfig(dir, changed);
    assert.deepEqual(loadConfig(dir), changed);
    for (const [key, value] of [['subagentLevels', 0], ['maxAgents', -1], ['previousExchangeKB', 1.5], ['subagentLevels', '3'], ['previousExchange', 'yes'], ['summaryAcceptBytes', 511]] as const) {
      writeFileSync(join(dir, 'config.json'), JSON.stringify({ ...changed, [key]: value }));
      assert.throws(() => loadConfig(dir), /Invalid profile config/, `${key}: ${value}`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('by default only the main agent starts subagents: a child gets no spawn or tell', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-levels-'));
  const { children: c, releases, close } = await children(dir);
  try {
    const [child] = await c.spawn([{ task: 'hold child' }], dir);
    await until(() => releases.size === 1);
    const tools = c.live(child)?.session.getActiveToolNames() ?? [];
    assert.ok(tools.includes('zoom') && !tools.includes('spawn') && !tools.includes('tell'));
    await assert.rejects(c.spawn([{ task: 'nested' }], dir, undefined, child), /allows 1 level of subagents/);
  } finally { await close(); rmSync(dir, { recursive: true, force: true }); }
});

test('subagent levels and max active agents come from the profile, read at each spawn', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-limits-'));
  const settings = { subagentLevels: 2, maxAgents: 3 };
  const { children: c, releases, close } = await children(dir, () => settings);
  try {
    const [child] = await c.spawn([{ task: 'hold child' }], dir);
    assert.ok(c.live(child)?.session.getActiveToolNames().includes('spawn'));
    const [grandchild] = await c.spawn([{ task: 'hold grandchild' }], dir, undefined, child);
    assert.ok(!c.live(grandchild)?.session.getActiveToolNames().includes('spawn'), 'the last level cannot delegate');
    await assert.rejects(c.spawn([{ task: 'hold too deep' }], dir, undefined, grandchild), /allows 2 levels/);
    await assert.rejects(c.spawn([{ task: 'hold a' }, { task: 'hold b' }], dir), /at most 3 active agents/);
    settings.maxAgents = 4;
    await c.spawn([{ task: 'hold a' }, { task: 'hold b' }], dir);
    assert.equal(c.ids.length, 4);
    await until(() => releases.size === 4);
  } finally { await close(); rmSync(dir, { recursive: true, force: true }); }
});

test('the previous exchange can be turned off, and its size limit is the profile\'s', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-previous-'));
  const oldHome = process.env.OPTCHAT_HOME;
  process.env.OPTCHAT_HOME = dir;
  const turns: Context[] = [];
  const { runtime } = await fixture(dir, context => {
    if (context.messages.some(m => m.role === 'system' && m.content === COMPACT)) return 'summary';
    turns.push(structuredClone(context));
    const asked = textContent(context.messages.at(-1)?.content).split('</chat>').at(-1)?.trim() ?? '';
    return asked === 'Long answer please.' ? 'x'.repeat(3000) : `Answer to: ${asked}`;
  });
  const profile = profilePath('fixture');
  let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined;
  const open = async (config: Partial<ProfileConfig>) => {
    saveConfig(profile, { ...loadConfig(profile), compactor: model, ...config });
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } });
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, 'agent'), settingsManager,
      noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, extensionFactories: [optchat] });
    await loader.reload();
    const manager = SessionManager.inMemory(dir);
    manager.appendCustomEntry('optchat.profile', { name: 'fixture' });
    session = (await createAgentSession({ modelRuntime: runtime, model: runtime.getModel('fixture', 'fixture'), resourceLoader: loader, settingsManager, sessionManager: manager, tools: ['zoom'] })).session;
    await session.bindExtensions({});
    return session;
  };
  const close = async () => { await session?.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session?.dispose(); session = undefined; };
  const messages = (turn: Context) => turn.messages.filter(m => m.role !== 'system').map(m => m.role);
  const continuity = (turn: Context) => JSON.stringify(turn.messages.find(m => m.role === 'system')).includes('immediately preceding completed exchange');
  try {
    createProfile('fixture');
    let s = await open({ previousExchange: false });
    await s.prompt('First.'); await s.prompt('Why?');
    assert.deepEqual(messages(turns.at(-1)!), ['user'], 'off: the follow-up sees the memory view only');
    assert.ok(!continuity(turns.at(-1)!), 'off: the prompt does not mention a replayed exchange');
    await close();
    s = await open({ previousExchange: true, previousExchangeKB: 2 });
    await s.prompt('Short answer please.'); await s.prompt('Why?');
    assert.deepEqual(messages(turns.at(-1)!), ['user', 'assistant', 'user']);
    assert.ok(continuity(turns.at(-1)!));
    await s.prompt('Long answer please.'); await s.prompt('Why?');
    assert.deepEqual(messages(turns.at(-1)!), ['user'], 'a 3 KB exchange is over a 2 KB limit');
  } finally {
    await close();
    if (oldHome === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = oldHome;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the settings page saves a valid number and explains an invalid one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-page-'));
  try {
    const plain = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;
    const config: ProfileConfig = { ...defaults };
    const page = settingsPage(plain, { profile: 'demo', config, models: ['anthropic/claude-sonnet-5-5'], save: next => saveConfig(dir, next) }, () => {});
    const type = (...keys: string[]) => { for (const key of keys) page.handleInput(key); };
    assert.match(page.render(100).join('\n'), /Subagent levels\s+1  default/);
    type('\x1b[B', '\x1b[B', '\r'); // down to Subagent levels, open it
    type('0', '\r');
    assert.match(page.render(100).join('\n'), /must be a whole number of 1 or more/);
    type('\x7f', 'x', '\r');
    assert.match(page.render(100).join('\n'), /must be a whole number of 1 or more/);
    type('\x7f', '3', '\r');
    assert.equal(config.subagentLevels, 3);
    assert.equal(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).subagentLevels, 3);
    assert.match(page.render(100).join('\n'), /Subagent levels\s+3  default 1[\s\S]*Saved subagent levels 3/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
