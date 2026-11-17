import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import optchat from '../src/index.ts';
import { controlImport, historyRoots, previewImport, readImport, readMemory, scanLocal, startImport, type Conversation, type ImportStatus } from '../src/files.ts';
import { Memory } from '../src/memory.ts';
import { prepareImport, runImport } from '../src/import/job.ts';
import { createProfile, describeOwner, loadConfig, lockProfile, memoryDirectory, profilePath, saveConfig } from '../src/profiles.ts';
import { COMPACT } from '../src/core/prompts.ts';
import { emptyUsage } from '../src/usage.ts';
import { removeDir } from './support.ts';

const lines = (path: string, items: unknown[]) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, items.map(i => JSON.stringify(i)).join('\n') + '\n'); };
// Over a node's 512 bytes, so each needs a summary from the compactor.
const long = (what: string) => `${what} `.repeat(120);
/** A Claude Code and a Codex conversation under `home`, Codex's a day earlier. */
function histories(home: string) {
  const claude = (uuid: string, role: 'user' | 'assistant', text: string) => ({ type: role, uuid, sessionId: 'claude-1', cwd: '/app', timestamp: '2026-03-02T10:00:00.000Z',
    message: { role, content: role === 'user' ? text : [{ type: 'text', text }], ...role === 'assistant' && { stop_reason: 'end_turn' } } });
  lines(join(home, '.claude/projects/app/claude-1.jsonl'), [claude('u1', 'user', long('claude question')), claude('a1', 'assistant', long('claude answer'))]);
  const row = (payload: unknown) => ({ type: 'response_item', timestamp: '2026-03-01T10:00:00.000Z', payload });
  lines(join(home, '.codex/sessions/codex-1.jsonl'), [
    { type: 'session_meta', timestamp: '2026-03-01T10:00:00.000Z', payload: { id: 'codex-1', cwd: '/app', timestamp: '2026-03-01T10:00:00.000Z' } },
    row({ type: 'message', role: 'user', content: [{ type: 'input_text', text: long('codex question') }] }),
    row({ type: 'message', role: 'assistant', channel: 'final', content: [{ type: 'output_text', text: long('codex answer') }] }),
  ]);
}
async function scanned(home: string) {
  const [claude, codex] = await Promise.all([scanLocal('claude', await historyRoots('claude', home)), scanLocal('codex', await historyRoots('codex', home))]);
  return [...claude.conversations, ...codex.conversations];
}
const temp = (name: string) => mkdtempSync(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), name));

test('an app scans a home of its choosing and previews conversations from several sources at once', async () => {
  const dir = temp('oc-import-preview-'), home = join(dir, 'home'), oldHome = process.env.OPTCHAT_HOME;
  process.env.OPTCHAT_HOME = join(dir, 'optchat');
  try {
    histories(home); createProfile('fixture');
    const conversations = await scanned(home);
    assert.deepEqual(conversations.map(c => [c.source, c.id]), [['claude', 'claude-1'], ['codex', 'codex-1']]);
    const preview = await previewImport(profilePath('fixture'), conversations);
    assert.deepEqual([preview.conversations, preview.added, preview.skipped, preview.warnings, preview.memory], [2, 4, 0, [], { messages: 0, summaries: 0 }]);
    // Empty memory: rebuild indexes the same text, and both count the two conversation notes too.
    assert.ok(preview.append.tokens > 4 * 120 * 3 && preview.append.tokens === preview.rebuild.tokens);
    assert.ok(preview.append.summaries >= 6);
  } finally {
    if (oldHome === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = oldHome;
    removeDir(dir);
  }
});

test('a pending import reads paused with its last numbers once its Pi is gone, and running while that Pi holds the profile', async () => {
  const dir = temp('oc-import-status-'), old = new Memory(dir, async () => 'summary');
  try {
    await old.close();
    const job = prepareImport(dir, old, [{ kind: 'user', text: 'hello', date: '2026-01-01T00:00:00.000Z', receipt: 'import:one' }], 'append');
    assert.ok(job);
    assert.equal((await readImport(dir)).state, 'paused', 'staged but never run');
    writeFileSync(join(dir, 'imports', 'status.json'), JSON.stringify({ id: job.id, state: 'running', pid: process.pid, messages: 1, summaries: 0, error: 'rate limited' }));
    assert.deepEqual(await readImport(dir), { state: 'paused', mode: 'append', created: job.created, added: 1, skipped: 0, messages: 1, total: 1, summaries: 0, error: 'rate limited' });
    const unlock = await lockProfile(dir, describeOwner({ profile: 'fixture', pid: process.pid, host: 'here', cwd: dir }));
    try { assert.equal((await readImport(dir)).state, 'running'); } finally { await unlock(); }
    // A run that can't start says why, for an app that only polls.
    rmSync(join(dir, job.target, 'staged.jsonl'));
    await assert.rejects(runImport(dir, async () => 'summary', AbortSignal.timeout(5000)), /staging data is missing/);
    const failed = await readImport(dir);
    assert.deepEqual(failed.state !== 'idle' && [failed.state, failed.error], ['failed', 'Import staging data is missing; original memory remains intact.']);
  } finally { await old.close(); removeDir(dir); }
});

test('an app starts, pauses, resumes and discards an import in the Pi that owns the profile', async () => {
  const dir = temp('oc-import-app-'), home = join(dir, 'home'), oldHome = process.env.OPTCHAT_HOME;
  process.env.OPTCHAT_HOME = join(dir, 'optchat');
  // The compactor holds its summaries until the test opens the gate, so the import is still running when it is paused.
  let open = false;
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false });
  runtime.registerProvider('fixture', {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
    models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple(m, context, options) {
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'summary' }], api: m.api, provider: m.provider, model: m.id,
        timestamp: Date.now(), stopReason: 'stop', usage: emptyUsage() };
      void (async () => {
        if (context.messages.some(x => x.role === 'system' && x.content === COMPACT)) while (!open && !options?.signal?.aborted) await sleep(10);
        if (options?.signal?.aborted) stream.push({ type: 'error', reason: 'aborted', error: { ...message, stopReason: 'aborted' } });
        else stream.push({ type: 'done', reason: 'stop', message });
        stream.end();
      })();
      return stream;
    },
  });
  let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined;
  const quit = async () => { if (session) { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); session = undefined; } };
  const settled = async (state: ImportStatus['state']) => {
    for (let i = 0; i < 500; i++) { const now = await readImport(profile); if (now.state === state) return now; await sleep(20); }
    throw new Error(`import never became ${state}`);
  };
  const profile = join(dir, 'optchat', 'profiles', 'fixture');
  try {
    histories(home); createProfile('fixture');
    assert.equal(profilePath('fixture'), profile);
    const fixture = { provider: 'fixture', model: 'fixture', thinking: 'off' as const };
    saveConfig(profile, { ...loadConfig(profile), compactor: fixture, subagent: fixture });
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } });
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, 'agent'), settingsManager,
      noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, extensionFactories: [optchat] });
    await loader.reload();
    const manager = SessionManager.inMemory(dir);
    manager.appendCustomEntry('optchat.profile', { name: 'fixture' });
    const opened = (await createAgentSession({ modelRuntime: runtime, model: runtime.getModel('fixture', 'fixture'), resourceLoader: loader, settingsManager, sessionManager: manager })).session;
    session = opened;
    // As Pi's new session after an import: the profile closes and opens again, on the memory the import switched to.
    const newSession = async () => {
      await opened.extensionRunner.emit({ type: 'session_shutdown', reason: 'new' });
      await opened.extensionRunner.emit({ type: 'session_start', reason: 'new' });
      return { cancelled: false };
    };
    const cancelled = async () => ({ cancelled: false });
    await opened.bindExtensions({ uiContext: opened.extensionRunner.getUIContext(), mode: 'tui',
      commandContextActions: { waitForIdle: async () => {}, newSession, fork: cancelled, navigateTree: cancelled, switchSession: cancelled, reload: async () => {} } });

    const conversations: Conversation[] = await scanned(home);
    const started = await startImport(profile, { conversations, mode: 'append' });
    // Two messages and a note for each conversation.
    assert.deepEqual([started.state, started.state !== 'idle' && [started.added, started.total, started.mode]], ['running', [6, 6, 'append']]);
    await assert.rejects(startImport(profile, { conversations, mode: 'append' }), /already open/);

    const paused = await controlImport(profile, 'pause');
    assert.equal(paused.state, 'paused');
    assert.deepEqual(await readImport(profile), paused);

    // Right after the pause: the owner is still opening its new session, which the request waits for.
    open = true;
    await controlImport(profile, 'resume');
    const done = await settled('idle');
    assert.deepEqual(done.state === 'idle' && done.last && [done.last.added, done.last.mode], [6, 'append']);
    // One run, two sources, in date order: Codex's conversation started a day earlier.
    const memory = await readMemory(memoryDirectory(profile));
    assert.deepEqual(memory.entries().map(e => [e.origin?.source, e.kind]),
      [['codex', 'note'], ['codex', 'user'], ['codex', 'talk'], ['claude', 'note'], ['claude', 'user'], ['claude', 'talk']]);
    await assert.rejects(startImport(profile, { conversations, mode: 'append' }), /Nothing new to import \(4 messages already present\)/);

    // A pending import outlives its Pi: it reads paused, and an app discards it without one.
    open = false;
    lines(join(home, '.claude/projects/app/claude-2.jsonl'), [{ type: 'user', uuid: 'u2', sessionId: 'claude-2', cwd: '/app', timestamp: '2026-03-03T10:00:00.000Z', message: { role: 'user', content: long('later') } }]);
    // Claude's first conversation is in memory already: its two messages count as skipped.
    const claude = (await scanned(home)).filter(c => c.source === 'claude');
    const again = await startImport(profile, { conversations: claude, mode: 'append' });
    assert.deepEqual(again.state === 'running' && [again.added, again.skipped], [2, 2]);
    await quit();
    assert.equal((await readImport(profile)).state, 'paused');
    const discarded = await controlImport(profile, 'discard');
    assert.deepEqual(discarded.state === 'idle' && discarded.last?.added, 6, 'back to idle, the earlier import still the last one');
    assert.equal((await readMemory(memoryDirectory(profile))).root.length, 6);
  } finally {
    open = true; await quit();
    if (oldHome === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = oldHome;
    removeDir(dir);
  }
});
