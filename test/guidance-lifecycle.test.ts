import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
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
import { GuidanceRequests } from '../src/guidance-recall.ts';
import { removeDir } from './support.ts';

const system = (context: Context) => { const head = context.messages[0]; return head?.role === 'system' ? getSystemMessageText(head) : ''; };
const notices = (context: Context) => context.messages.filter(m => textContent(m.content).includes('<guidance_update>'));
async function runtime(dir: string, respond: (context: Context) => AssistantMessage['content'], contextWindow = 1000, usageInput = () => 0) {
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false });
  runtime.registerProvider('guidance-test', { baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
    models: [{ id: 'model', name: 'Fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow, maxTokens: 100 }],
    streamSimple(model, context) {
      const content = system(context) === COMPACT ? [{ type: 'text' as const, text: 'Summary.' }] : respond(context);
      const stopReason = content.some(b => b.type === 'toolCall') ? 'toolUse' : 'stop';
      const usage = emptyUsage(); usage.input = usage.totalTokens = usageInput();
      const message: AssistantMessage = { role: 'assistant', content, stopReason, api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), usage };
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
    const beforeFailure = captured.length, states = session!.sessionManager.getBranch().filter(e => e.type === 'custom' && e.customType === GUIDANCE_STATE).length;
    const requests = join(profile, 'guidance', 'requests'), backup = join(profile, 'guidance', 'requests-backup');
    renameSync(requests, backup); writeFileSync(requests, 'unwritable request directory');
    writeFileSync(source, 'A new revision that cannot be associated.');
    await session!.prompt('Continue despite the simulated storage failure.');
    assert.equal(captured.length, beforeFailure, 'archive association failure must stop provider dispatch');
    assert.equal(session!.sessionManager.getBranch().filter(e => e.type === 'custom' && e.customType === GUIDANCE_STATE).length, states,
      'failed request persistence must not advance the last supplied revision');
    rmSync(requests); renameSync(backup, requests);
    const log = readdirSync(join(profile, 'main')).map(name => readFileSync(join(profile, 'main', name), 'utf8')).join('');
    const rows = log.trim().split('\n').map(line => JSON.parse(line));
    const firstTool = rows.find(e => e.kind === 'tool'), firstEcho = rows.find(e => e.kind === 'echo');
    assert.equal(firstTool.guidance.request, firstEcho.guidance.request, 'a tool action and its result share the request that issued it');
    assert.equal(rows[0].guidance.request, firstTool.guidance.request, 'the original input is bound to the initial request');
    const readRequest = (id: string) => JSON.parse(readFileSync(join(profile, 'guidance', 'requests', `${id}.json`), 'utf8'));
    assert.equal(readRequest(firstTool.guidance.request).revision, (first.data as GuidanceState).revision.id);
    assert.notEqual(rows.filter(e => e.kind === 'tool')[1].guidance.request, firstTool.guidance.request);
    assert.ok(captured.some(c => JSON.stringify(c).includes('<historical_guidance>')), 'zoom annotations actually reach the model');
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
    const associations = children.guidanceForTranscript(id);
    assert.ok(associations.size >= 4);
    const archive = new GuidanceRequests(profile);
    const descriptions = [...associations.values()].map(ref => archive.describe([ref]));
    assert.ok(descriptions.some(text => text.includes('historical_guidance')));
    assert.equal(new Set([...associations.values()].map(ref => ref.request)).size, 3, 'initial, post-tool and resumed requests stay distinct');
    assert.deepEqual(warnings, []);
  } finally { await children.close(); await memory.close(); removeDir(dir); }
});

test('a running child aborts before another provider call when current guidance cannot be read', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-guidance-failure-')), cwd = join(dir, 'project'), profile = join(dir, 'profile');
  mkdirSync(cwd); mkdirSync(profile); const source = join(cwd, 'AGENTS.md'); writeFileSync(source, 'Use SQLite.');
  const memory = new Memory(profile, async () => 'Summary.'); memory.append('user', 'Task.');
  let calls = 0;
  const rt = await runtime(dir, () => {
    calls++; writeFileSync(source, Buffer.from([0xff]));
    return [{ type: 'toolCall', id: 'date', name: 'date', arguments: { id: 0 } }];
  });
  const warnings: string[] = [];
  const children = new Children(memory, new ModelRegistry(rt), () => ({ provider: 'guidance-test', model: 'model', thinking: 'off' }), () => '', async () => {}, message => warnings.push(message), profile,
    { createSession: options => createAgentSession({ ...options, modelRuntime: rt }), settings: () => ({ refreshAt: 0 }) });
  try {
    await children.spawn([{ task: 'Check date.', cwd }], dir);
    const deadline = Date.now() + 5000;
    while (children.active) { assert.ok(Date.now() < deadline, 'child must stop after guidance failure'); await new Promise(resolve => setTimeout(resolve, 5)); }
    assert.equal(calls, 1, 'Pi must not fall back to its stale cached prompt after an extension error');
    assert.ok(warnings.some(warning => warning.includes('Cannot read current guidance')));
  } finally { await children.close(); await memory.close(); removeDir(dir); }
});


test('actual Pi subagent compaction retains current guidance, earlier transitions and exact retained-work associations', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-guidance-compact-')), cwd = join(dir, 'project'), profile = join(dir, 'profile');
  mkdirSync(cwd); mkdirSync(profile);
  const extensions = join(cwd, '.pi', 'extensions'); mkdirSync(extensions, { recursive: true });
  writeFileSync(join(extensions, 'fixture.js'), `export default pi => pi.on('session_before_compact', event => ({ compaction: {
    summary: 'Earlier work summarized.', firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore
  } }));`);
  const source = join(cwd, 'AGENTS.md'); writeFileSync(source, 'Use SQLite.');
  const memory = new Memory(profile, async () => 'Summary.'); memory.append('user', 'Reference material. '.repeat(2000));
  const captured: Context[] = []; let calls = 0;
  const rt = await runtime(dir, context => {
    captured.push(structuredClone(context)); calls++;
    if (calls === 1) writeFileSync(source, 'Use PostgreSQL.');
    return calls <= 2 ? [...(calls === 1 ? [{ type: 'text' as const, text: 'EARLY_WORK '.repeat(3000) }] : []),
      { type: 'toolCall', id: `zoom-${calls}`, name: 'zoom', arguments: { id: 0 } }] : [{ type: 'text', text: 'Done.' }];
  }, 100000, () => calls === 2 ? 70000 : 100);
  const warnings: string[] = [];
  const children = new Children(memory, new ModelRegistry(rt), () => ({ provider: 'guidance-test', model: 'model', thinking: 'off' }), () => '', async () => {}, warning => warnings.push(warning), profile, {
    createSession: options => createAgentSession({ ...options, modelRuntime: rt,
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: true, reserveTokens: 38000, keepRecentTokens: 1000 }, retry: { enabled: false }, cacheWarming: 'off' }) }),
  });
  try {
    const [id] = await children.spawn([{ task: 'Inspect reference twice.', cwd }], dir);
    const deadline = Date.now() + 10000;
    while (children.active) { assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 5)); }
    assert.equal(captured.length, 3);
    const manager = SessionManager.open(children.history.records.get(id)!.sessionFile!);
    assert.equal(manager.getEntries().filter(e => e.type === 'compaction').length, 1);
    assert.match(system(captured[2]), /Use PostgreSQL/);
    assert.doesNotMatch(system(captured[2]), /Use SQLite/);
    assert.match(JSON.stringify(notices(captured[2])), /already applied, not a new change/);
    const messages = children.transcript(id)!, refs = children.guidanceForTranscript(id);
    const early = messages.findIndex(m => m.role === 'assistant' && textContent(m.content).includes('EARLY_WORK'));
    assert.ok(early >= 0 && refs.has(early));
    const archived = new GuidanceRequests(profile).describe([refs.get(early)!]);
    const firstState = manager.getEntries().find(e => e.type === 'custom' && e.customType === GUIDANCE_STATE)!;
    assert.equal(firstState.type, 'custom');
    const original = (firstState.data as GuidanceState).revision.files.find(f => f.path === source)!;
    assert.ok(archived.includes(original.archive));
    assert.equal(readFileSync(original.archive, 'utf8'), 'Use SQLite.');
    assert.deepEqual(warnings, []);
  } finally { await children.close(); await memory.close(); removeDir(dir); }
});
