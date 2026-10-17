import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAssistantMessageEventStream, getSystemMessageText, type AssistantMessage, type Context } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRegistry, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import optchat from '../src/index.ts';
import { Children } from '../src/agents.ts';
import { Memory } from '../src/memory.ts';
import { createProfile, loadConfig, profilePath, saveConfig } from '../src/profiles.ts';
import { COMPACT, TURN_REFRESHED } from '../src/prompts.ts';
import { REPORT_TYPE, textContent } from '../src/transcript.ts';
import { emptyUsage } from '../src/usage.ts';
import { GUIDANCE_STATE, type GuidanceState } from '../src/guidance.ts';
import { removeDir } from './support.ts';

const system = (context: Context) => { const head = context.messages[0]; return head?.role === 'system' ? getSystemMessageText(head) : ''; };
const notices = (context: Context) => context.messages.filter(m => textContent(m.content).includes('<guidance_update>'));
async function runtime(dir: string, respond: (context: Context) => AssistantMessage['content']) {
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false });
  runtime.registerProvider('guidance-test', { baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
    models: [{ id: 'model', name: 'Fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 }],
    streamSimple(model, context) {
      const content = system(context) === COMPACT ? [{ type: 'text' as const, text: 'Summary.' }] : respond(context);
      const stopReason = content.some(b => b.type === 'toolCall') ? 'toolUse' : 'stop';
      const message: AssistantMessage = { role: 'assistant', content, stopReason, api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), usage: emptyUsage() };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => { stream.push({ type: 'done', reason: stopReason, message }); stream.end(); });
      return stream;
    } });
  return runtime;
}

test('main requests refresh guidance after tools, report wake, memory refresh and restart without logging notices', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-guidance-main-')), cwd = join(dir, 'project'); mkdirSync(cwd);
  const oldHome = process.env.OPTCHAT_HOME, oldBudget = process.env.OPTCHAT_REFRESH_AT;
  process.env.OPTCHAT_HOME = dir; process.env.OPTCHAT_REFRESH_AT = '1';
  createProfile('fixture'); const profile = profilePath('fixture'), source = join(cwd, 'AGENTS.md');
  const config = loadConfig(profile); saveConfig(profile, { ...config, compactor: { provider: 'guidance-test', model: 'model', thinking: 'off' } });
  writeFileSync(source, 'Use SQLite.');
  const captured: Context[] = []; let calls = 0;
  const rt = await runtime(dir, context => {
    captured.push(structuredClone(context)); calls++;
    if (calls === 1) writeFileSync(source, 'Use PostgreSQL.'); // While the first response is issued.
    if (calls === 2) utimesSync(source, new Date(), new Date(Date.now() + 10000));
    return calls <= 8 ? [{ type: 'toolCall', id: `zoom-${calls}`, name: 'zoom', arguments: { id: 0 } }] : [{ type: 'text', text: 'Done.' }];
  });
  let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined;
  const errors: string[] = [];
  async function open(manager: SessionManager) {
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } });
    const loader = new DefaultResourceLoader({ cwd, agentDir: join(dir, 'agent'), settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, extensionFactories: [optchat] });
    await loader.reload();
    const result = await createAgentSession({ cwd, modelRuntime: rt, model: rt.getModel('guidance-test', 'model'), resourceLoader: loader, settingsManager, sessionManager: manager, tools: ['zoom'] });
    session = result.session; await session.bindExtensions({ onError: error => errors.push(error.error) });
  }
  try {
    const manager = SessionManager.create(cwd, join(dir, 'sessions')); manager.appendCustomEntry('optchat.profile', { name: 'fixture' });
    await open(manager);
    const task = 'Inspect message zero eight times. ' + 'Task background. '.repeat(45);
    await session!.prompt(task);
    assert.equal(captured.length, 9);
    assert.match(system(captured[0]), /Use SQLite/);
    assert.equal(notices(captured[0]).length, 0);
    assert.match(system(captured[1]), /Use PostgreSQL/);
    assert.doesNotMatch(system(captured[1]), /Use SQLite/);
    assert.equal(system(captured[1]), system(captured[2]), 'a touch does not change the leading prompt');
    assert.equal(notices(captured[1]).length, 1);
    assert.equal(captured[1].messages.at(-1), notices(captured[1])[0], 'the first notice follows the completed tool result');
    assert.deepEqual(notices(captured[1]), notices(captured[2]), 'the same notice stays at its work boundary');
    assert.notEqual(captured[2].messages.at(-1), notices(captured[2])[0]);
    assert.ok(captured.some(c => JSON.stringify(c).includes(TURN_REFRESHED)), 'real memory refresh occurred');
    assert.ok(captured.some(c => JSON.stringify(notices(c)).includes('already applied, not a new change')));
    const entries = manager.getBranch().filter(e => e.type === 'custom' && e.customType === GUIDANCE_STATE);
    assert.equal(entries.length, 2, 'only initial injection and actual revision change persist state');
    const first = entries[0]; assert.equal(first.type, 'custom');
    const old = (first.data as GuidanceState).revision.files.find(f => f.path === source)!;
    assert.equal(readFileSync(old.archive, 'utf8'), 'Use SQLite.');
    // Idle reports bypass before_agent_start, but still get the new source and matching notice.
    writeFileSync(source, 'Use PostgreSQL with migrations.');
    await session!.sendCustomMessage({ customType: REPORT_TYPE, content: '[child] Finished.', display: true }, { triggerTurn: true, deliverAs: 'steer' });
    await session!.agent.waitForIdle();
    assert.match(system(captured.at(-1)!), /Use PostgreSQL with migrations/);
    assert.match(JSON.stringify(notices(captured.at(-1)!)), /previous excerpt.*Use PostgreSQL/);
    const file = manager.getSessionFile()!;
    await session!.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session!.dispose(); session = undefined;
    await open(SessionManager.open(file));
    await session!.prompt('Continue after restart.');
    assert.match(system(captured.at(-1)!), /Use PostgreSQL with migrations/);
    assert.match(JSON.stringify(notices(captured.at(-1)!)), /already applied, not a new change/);
    rmSync(source);
    await session!.prompt('Continue after removal.');
    assert.doesNotMatch(system(captured.at(-1)!), /Use PostgreSQL/);
    assert.equal(readFileSync(old.archive, 'utf8'), 'Use SQLite.');
    const log = readdirSync(join(profile, 'main')).map(name => readFileSync(join(profile, 'main', name), 'utf8')).join('');
    const tree = readdirSync(join(profile, 'tree')).map(name => readFileSync(join(profile, 'tree', name), 'utf8')).join('');
    assert.doesNotMatch(log + tree, /guidance_update|guidance\/sources|historical copies|Use SQLite|Use PostgreSQL/);
    assert.deepEqual(errors, []);
  } finally {
    if (session) { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); }
    if (oldHome === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = oldHome;
    if (oldBudget === undefined) delete process.env.OPTCHAT_REFRESH_AT; else process.env.OPTCHAT_REFRESH_AT = oldBudget;
    removeDir(dir);
  }
});

test('running and resumed subagents observe their own project and their own revision boundary', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-guidance-child-')), cwd = join(dir, 'project'), profile = join(dir, 'profile');
  mkdirSync(cwd); mkdirSync(profile); const source = join(cwd, 'AGENTS.md'); writeFileSync(source, 'Use SQLite.');
  const memory = new Memory(profile, async input => input.source.slice(0, 100), () => {}); memory.append('user', 'Task.');
  const captured: Context[] = []; let calls = 0;
  const rt = await runtime(dir, context => {
    captured.push(structuredClone(context)); calls++;
    if (calls === 1) writeFileSync(source, 'Use PostgreSQL.');
    return calls === 1 ? [{ type: 'toolCall', id: 'date', name: 'date', arguments: { id: 0 } }] : [{ type: 'text', text: 'Done.' }];
  });
  const warnings: string[] = [];
  const children = new Children(memory, new ModelRegistry(rt), () => ({ provider: 'guidance-test', model: 'model', thinking: 'off' }), () => '', async () => {}, message => warnings.push(message), profile,
    { createSession: options => createAgentSession({ ...options, modelRuntime: rt }), settings: () => ({ refreshAt: 0 }) });
  const settled = async () => {
    const deadline = Date.now() + 10000;
    while (children.active) { if (Date.now() > deadline) throw new Error('Child did not settle'); await new Promise(resolve => setTimeout(resolve, 5)); }
  };
  try {
    const [id] = await children.spawn([{ task: 'Check date.', cwd }], dir); await settled();
    assert.equal(captured.length, 2);
    assert.match(system(captured[0]), /Use SQLite/); assert.match(system(captured[1]), /Use PostgreSQL/);
    assert.equal(notices(captured[0]).length, 0); assert.equal(notices(captured[1]).length, 1);
    await children.tell(id, 'Continue.', 'manager'); await settled();
    assert.match(system(captured[2]), /Use PostgreSQL/);
    assert.equal(notices(captured[2]).length, 1);
    assert.notEqual(captured[2].messages.at(-1), notices(captured[2])[0], 'resumed work follows the original notice');
    assert.deepEqual(warnings, []);
  } finally { await children.close(); await memory.close(); removeDir(dir); }
});
