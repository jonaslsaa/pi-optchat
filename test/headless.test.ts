import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionUIContext } from '@earendil-works/pi-coding-agent';
import optchat from '../src/index.ts';
import { createProfile, lastProfile, loadConfig, lockProfile, profilePath, rememberProfile, saveConfig } from '../src/profiles.ts';
import { textContent } from '../src/transcript.ts';
import { emptyUsage } from '../src/usage.ts';

// Short paths: the profile lock socket has a ~103-byte limit on macOS.
const root = mkdtempSync('/tmp/oc-headless-');
const oldHome = process.env.OPTCHAT_HOME;
process.env.PI_CODING_AGENT_DIR = join(root, 'agent');
process.env.OPTCHAT_HOME = join(root, 'home');
after(() => {
  if (oldHome === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = oldHome;
  rmSync(root, { recursive: true, force: true });
});
for (const name of ['work', 'personal']) {
  createProfile(name);
  saveConfig(profilePath(name), { ...loadConfig(profilePath(name)), compactor: { provider: 'fixture', model: 'fixture', thinking: 'off' }, subagent: { provider: 'fixture', model: 'fixture', thinking: 'off' } });
}
rememberProfile('personal');

/** A headless Pi (print or RPC) whose model answers "OK to: <prompt>" and records what each call was sent. */
async function headless(mode: 'print' | 'rpc', options: { flag?: string; bound?: string; connect?: string } = {}) {
  const dir = mkdtempSync(join(root, 's-'));
  const sent: string[] = [], errors: string[] = [];
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false });
  runtime.registerProvider('fixture', {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
    models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple(model, context) {
      sent.push(JSON.stringify(context.messages));
      const last = context.messages.at(-1);
      const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: `OK to: ${textContent(last && 'content' in last ? last.content : '')}` }],
        api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: 'stop', usage: emptyUsage() };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => { stream.push({ type: 'start', partial: message }); stream.push({ type: 'done', reason: 'stop', message }); stream.end(); });
      return stream;
    },
  });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, 'agent'), settingsManager,
    noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, extensionFactories: [optchat] });
  await loader.reload();
  const manager = SessionManager.create(dir, join(dir, 'sessions'));
  if (options.bound) manager.appendCustomEntry('optchat.profile', { name: options.bound });
  const { session } = await createAgentSession({ modelRuntime: runtime, model: runtime.getModel('fixture', 'fixture'), resourceLoader: loader, settingsManager, sessionManager: manager, tools: [] });
  if (options.flag) session.extensionRunner.setFlagValue('optchat-profile', options.flag);
  if (options.connect) session.extensionRunner.setFlagValue('optchat-connect', options.connect);
  // RPC hosts have a real UI, but a dialog there can hang the host (pi-acp), so any select fails the test.
  const uiContext: ExtensionUIContext = { ...session.extensionRunner.getUIContext(),
    select: async () => { throw new Error('a headless session must not ask for a profile'); } };
  await session.bindExtensions({ uiContext, mode, onError: error => { errors.push(error.error); } });
  const ask = async (text: string) => {
    await session.prompt(text);
    const reply = session.state.messages.at(-1);
    return reply?.role === 'assistant' ? textContent(reply.content) : undefined;
  };
  const bindings = () => manager.getEntries().flatMap(e => e.type === 'custom' && e.customType === 'optchat.profile' ? [e.data] : []);
  const close = async () => { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); };
  return { ask, bindings, close, errors, sent };
}

test('a headless run without a binding or --optchat-profile is plain Pi: it answers, and no profile is picked or created', async () => {
  for (const mode of ['print', 'rpc'] as const) {
    const pi = await headless(mode);
    try {
      assert.equal(await pi.ask('Say OK'), 'OK to: Say OK', `${mode}: the prompt reaches the model`);
      assert.deepEqual(pi.errors, []);
      assert.deepEqual(pi.bindings(), [], `${mode}: the session stays unbound`);
      assert.doesNotMatch(pi.sent[0], /You are OptChat/, `${mode}: Pi's own prompt is untouched`);
    } finally { await pi.close(); }
  }
  assert.ok(!existsSync(profilePath('default')), 'no default profile is created');
  assert.equal(lastProfile(), 'personal', 'the last-used profile is unchanged');
});

test('--optchat-profile still opens that profile headlessly', async () => {
  const pi = await headless('print', { flag: 'work' });
  try {
    assert.match(await pi.ask('Say OK') ?? '', /^OK to: <chat>[^]*Say OK$/, 'the prompt runs with the OptChat view');
    assert.deepEqual(pi.errors, []);
    assert.deepEqual(pi.bindings(), [{ name: 'work' }]);
    assert.match(pi.sent[0], /You are OptChat/);
  } finally { await pi.close(); }
});

test('a requested profile that cannot open fails visibly and does not run without memory', async () => {
  const unlock = await lockProfile(profilePath('work'), 'work · PID 1 · elsewhere');
  try {
    // `auto` would join the busy owner; this one has no windows socket, so the join fails too, with a failing exit code.
    for (const [why, options] of [['typo', { flag: 'wrok' }], ['busy', { bound: 'work', connect: 'off' }], ['busy, nothing to join', { bound: 'work' }],
      ['deleted', { bound: 'gone' }], ['join without a session', { flag: 'personal', connect: 'join' }], ['join with an invalid name', { flag: 'Work', connect: 'join' }]] as const) {
      process.exitCode = undefined;
      const pi = await headless('print', options);
      try {
        assert.equal(pi.errors.length, 1, `${why}: Pi reports the error (stderr in print mode)`);
        assert.equal(await pi.ask('Say OK'), undefined, `${why}: the prompt is not answered without memory`);
        assert.equal(pi.sent.length, 0);
        assert.equal(process.exitCode, why.includes('join') ? 1 : undefined, `${why}: exit code`);
      } finally { await pi.close(); }
    }
  } finally { process.exitCode = undefined; await unlock(); }
});
