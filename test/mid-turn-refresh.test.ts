import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream, type AssistantMessage, type Context } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import optchat from '../src/index.ts';
import { createProfile, loadConfig, profilePath, saveConfig } from '../src/profiles.ts';
import { buildContext, refreshedRun, textContent, turnBudget } from '../src/transcript.ts';
import { COMPACT, TURN_REFRESHED } from '../src/prompts.ts';
import { emptyUsage } from '../src/usage.ts';

const reply = (content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason']): AssistantMessage => ({
  role: 'assistant', content, timestamp: 2, stopReason, api: 'openai-completions', provider: 'fixture', model: 'fixture', usage: emptyUsage(),
});

test('with no turn budget the request is the one sent before mid-turn refresh existed', () => {
  assert.equal(turnBudget(200_000, Number(undefined)), undefined);
  assert.equal(turnBudget(200_000, 0), undefined);
  assert.equal(turnBudget(200_000, 0.25), 200_000);
  const run: AgentMessage[] = [{ role: 'user', content: 'task', timestamp: 1 }, reply([{ type: 'toolCall', id: 't', name: 'date', arguments: { id: 0 } }], 'toolUse'),
    { role: 'toolResult', toolCallId: 't', toolName: 'date', content: [{ type: 'text', text: 'Fri' }], isError: false, timestamp: 3 }];
  assert.deepEqual(buildContext([], refreshedRun(run, 0, TURN_REFRESHED), '<chat>\n</chat>', 'p'), buildContext([], run, '<chat>\n</chat>', 'p'));
});

test('a turn past its budget is sent as the refreshed view, its task verbatim and only its last tool call, and memory logs every step once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-refresh-'));
  const oldHome = process.env.OPTCHAT_HOME, oldBudget = process.env.OPTCHAT_TURN_BUDGET;
  process.env.OPTCHAT_HOME = dir;
  // A 1,000-token window at 100%: 4,000 characters, a little over two of the zooms below.
  process.env.OPTCHAT_TURN_BUDGET = '1';
  const task = `Zoom message 0 four times, then answer. ${'Context for the task. '.repeat(60)}`;
  const captured: Context[] = [];
  let calls = 0;
  let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined;
  try {
    createProfile('fixture');
    const config = loadConfig(profilePath('fixture'));
    saveConfig(profilePath('fixture'), { ...config, compactor: { provider: 'fixture', model: 'fixture', thinking: 'off' } });
    const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models-cache.json'), refreshOnCreate: false });
    runtime.registerProvider('fixture', {
      baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
      models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 1000 }],
      streamSimple(model, context) {
        const compression = context.messages.some(m => m.role === 'system' && m.content === COMPACT);
        if (!compression) captured.push(structuredClone({ ...context, messages: context.messages.filter(m => m.role !== 'system') }));
        const step = compression ? 0 : ++calls;
        const message = compression ? reply([{ type: 'text', text: 'Summary.' }], 'stop')
          : step <= 4 ? reply([{ type: 'toolCall', id: `zoom-${step}`, name: 'zoom', arguments: { id: 0, n: 1 } }], 'toolUse')
          : reply([{ type: 'text', text: 'Done.' }], 'stop');
        message.provider = model.provider; message.model = model.id;
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => { stream.push({ type: 'done', reason: message.stopReason === 'toolUse' ? 'toolUse' : 'stop', message }); stream.end(); });
        return stream;
      },
    });
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } });
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, 'agent'), settingsManager,
      noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, extensionFactories: [optchat] });
    await loader.reload();
    const manager = SessionManager.inMemory(dir); manager.appendCustomEntry('optchat.profile', { name: 'fixture' });
    session = (await createAgentSession({ modelRuntime: runtime, model: runtime.getModel('fixture', 'fixture'), resourceLoader: loader, settingsManager, sessionManager: manager, tools: ['zoom'] })).session;
    const errors: string[] = [];
    await session.bindExtensions({ onError: error => errors.push(error.error) });
    await session.prompt(task);
    assert.equal(session.getLastAssistantText(), 'Done.');
    assert.deepEqual(captured.map(c => c.messages.map(m => m.role).join(' ')), [
      'user', 'user assistant toolResult',
      // Over budget: the view now holds the first step, and the request only the second.
      'user assistant toolResult', 'user assistant toolResult assistant toolResult',
      // Over again: three steps since the last refresh.
      'user assistant toolResult']);
    const [first, refreshed] = [captured[0].messages[0], captured[2].messages[0]].map(m => textContent(m.content));
    assert.ok(first.endsWith(task) && !first.includes(TURN_REFRESHED));
    assert.ok(refreshed.includes(`\n\n${task}`) && refreshed.endsWith(TURN_REFRESHED), 'the task stays verbatim, then the note');
    const view = refreshed.slice(0, refreshed.indexOf('</chat>'));
    assert.ok(view.includes('|tool: zoom {"id":0,"n":1}') && view.includes('2+1|Summary.'), 'the moved steps are view lines');
    const ids = captured.map(c => c.messages.flatMap(m => m.role === 'assistant' ? m.content.flatMap(b => b.type === 'toolCall' ? [b.id] : []) : []).join(' '));
    assert.deepEqual(ids, ['', 'zoom-1', 'zoom-2', 'zoom-2 zoom-3', 'zoom-4']);
    const main = join(dir, 'profiles', 'fixture', 'main');
    const kinds = readdirSync(main).flatMap(file => readFileSync(join(main, file), 'utf8').trim().split('\n')).map(line => (JSON.parse(line) as { kind: string }).kind);
    assert.deepEqual(kinds, ['user', 'tool', 'echo', 'tool', 'echo', 'tool', 'echo', 'tool', 'echo', 'talk'], 'each step logged once');
    assert.deepEqual(errors, []);
  } finally {
    if (session) { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); }
    if (oldHome === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = oldHome;
    if (oldBudget === undefined) delete process.env.OPTCHAT_TURN_BUDGET; else process.env.OPTCHAT_TURN_BUDGET = oldBudget;
    rmSync(dir, { recursive: true, force: true });
  }
});
