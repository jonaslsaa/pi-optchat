import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAssistantMessageEventStream, getCurrentSystemPrompt, type AssistantMessage, type TranscriptContext } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRegistry, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import optchat from '../src/index.ts';
import { assertSubscriptionEnvironment, bridgePrompt, contextPrompt, summaryMessages } from '../src/claude-bridge.ts';
import { createCompressor } from '../src/compactor.ts';
import { createHandoffSummarizer } from '../src/handoff.ts';
import { Children } from '../src/agents.ts';
import { Memory } from '../src/memory.ts';
import { createProfile, profilePath, saveConfig } from '../src/profiles.ts';
import { emptyUsage } from '../src/usage.ts';
import { textContent } from '../src/transcript.ts';
import { COMPACT } from '../src/prompts.ts';
import type { RunInfo } from '../src/runs.ts';

const root = mkdtempSync(join(tmpdir(), 'optchat-bridge-unit-'));
process.env.PI_CODING_AGENT_DIR = join(root, 'agent');
mkdirSync(process.env.PI_CODING_AGENT_DIR);
writeFileSync(join(process.env.PI_CODING_AGENT_DIR, 'claude-bridge.json'), JSON.stringify({ startupNoticeShown: 'fixture', askClaude: { enabled: false }, provider: { longContextExtraUsage: false } }));
after(() => rmSync(root, { recursive: true, force: true }));
const choice = { provider: 'claude-bridge', model: 'fixture', thinking: 'off' as const };

async function fixture(reply: (context: TranscriptContext, summary: boolean) => string) {
  const dir = mkdtempSync(join(root, 'fixture-'));
  const requests: { context: TranscriptContext; cache?: string }[] = [];
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false });
  const provider = { baseUrl: 'claude-bridge', apiKey: 'synthetic', api: 'claude-bridge', models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text' as const], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 16000 }],
    streamSimple(model: Parameters<NonNullable<Parameters<typeof runtime.registerProvider>[1]['streamSimple']>>[0], context: TranscriptContext, options?: { cacheRetention?: string }) {
      requests.push({ context: structuredClone(context), cache: options?.cacheRetention });
      const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: reply(context, options?.cacheRetention === 'none') }], api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: 'stop', usage: emptyUsage() };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => { stream.push({ type: 'done', reason: 'stop', message }); stream.end(); });
      return stream;
    } };
  runtime.registerProvider(choice.provider, provider);
  return { dir, runtime, registry: new ModelRegistry(runtime), requests, provider };
}

test('bridge context keeps assembled sections and fails closed without a prompt; other providers are unchanged', () => {
  const messages = [{ role: 'system' as const, content: '', sections: { preamble: 'OptChat', project_context: 'REPO_RULES', skills: 'SKILL_RULES' }, timestamp: 0 }];
  assert.equal(contextPrompt(messages, 'old prompt', choice), getCurrentSystemPrompt(messages));
  assert.equal(contextPrompt(messages, 'old prompt', { provider: 'anthropic' }), 'old prompt');
  assert.throws(() => contextPrompt([], 'uncaptured prompt', choice), /refusing/);
  assert.match(bridgePrompt('OptChat', 'PROFILE_RULES'), /OptChat[\s\S]*PROFILE_RULES/);
  const user = [{ role: 'user' as const, content: 'hello', timestamp: 1 }];
  assert.equal(summaryMessages(user, { provider: 'anthropic' }), user);
});

test('subscription experiment rejects environment API/proxy overrides without disclosing values', () => {
  const name = 'ANTHROPIC_API_KEY', saved = process.env[name];
  try {
    process.env[name] = 'synthetic-private-value';
    assert.throws(() => assertSubscriptionEnvironment(), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /ANTHROPIC_API_KEY/);
      assert.ok(!error.message.includes('synthetic-private-value'));
      return true;
    });
  } finally { if (saved === undefined) delete process.env[name]; else process.env[name] = saved; }
});

test('compactor retries and handoffs use isolated summaries without losing the previous attempt', async () => {
  let attempts = 0;
  const f = await fixture((_context, summary) => {
    assert.ok(summary, 'summary calls must use upstream cacheRetention:none marker');
    return ++attempts === 1 ? 'OVERLONG_ATTEMPT '.repeat(50) : 'Short summary.';
  });
  const compress = createCompressor(f.registry, () => choice);
  assert.equal(await compress({ context: 'Prior memory', source: 'Original evidence', merge: false }, new AbortController().signal), 'Short summary.');
  assert.equal(f.requests.length, 2);
  for (const request of f.requests) {
    assert.equal(request.cache, 'none');
    assert.equal(getCurrentSystemPrompt(request.context.messages), COMPACT);
    assert.equal(request.context.messages.filter(m => m.role !== 'system').length, 1);
  }
  const retry = textContent(f.requests[1].context.messages.at(-1)?.content);
  for (const text of ['Original evidence', 'OVERLONG_ATTEMPT', 'the limit is 512']) assert.ok(retry.includes(text), text);
  const run: RunInfo = { id: 'fixture', task: 'user task', cwd: f.dir, model: 'claude-bridge/fixture', thinking: 'off', parentSession: '', depth: 1, started: Date.now(), state: 'completed', guidance: [], connected: true, handoff: { reason: 'complete' } };
  const handoff = await createHandoffSummarizer(f.registry, () => choice, () => {})(run, [{ role: 'user', content: 'initial request', timestamp: 1 }]);
  assert.equal(handoff, 'Short summary.');
  assert.equal(f.requests.at(-1)?.cache, 'none');
  assert.match(textContent(f.requests.at(-1)?.context.messages.at(-1)?.content), /USER REQUEST: user task/);
});

test('real bridge lifecycle captures main and child prompts with profile rules, AGENTS.md and skills (no model calls)', async () => {
  const oldEnabled = process.env.OPTCHAT_CLAUDE_BRIDGE, oldHome = process.env.OPTCHAT_HOME;
  process.env.OPTCHAT_CLAUDE_BRIDGE = '1';
  process.env.OPTCHAT_HOME = join(root, 'profiles-home');
  const f = await fixture(() => 'Done.');
  writeFileSync(join(f.dir, 'AGENTS.md'), 'REPO_RULES');
  const skill = join(process.env.PI_CODING_AGENT_DIR!, 'skills', 'fixture');
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, 'SKILL.md'), '---\nname: fixture\ndescription: FIXTURE_SKILL\n---\nBody');
  createProfile('fixture');
  writeFileSync(join(profilePath('fixture'), 'AGENTS.md'), 'PROFILE_RULES');
  saveConfig(profilePath('fixture'), { subagent: choice, compactor: choice });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off' });
  const loader = new DefaultResourceLoader({ cwd: f.dir, agentDir: process.env.PI_CODING_AGENT_DIR!, settingsManager, noExtensions: true, noPromptTemplates: true, extensionFactories: [optchat, pi => pi.registerProvider(choice.provider, f.provider)] });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const manager = SessionManager.inMemory(); manager.appendCustomEntry('optchat.profile', { name: 'fixture' });
  const { session } = await createAgentSession({ cwd: f.dir, modelRuntime: f.runtime, model: f.runtime.getModel(choice.provider, choice.model)!, sessionManager: manager, resourceLoader: loader, settingsManager, tools: ['read', 'zoom', 'date', 'spawn', 'tell'], thinkingLevel: 'off' });
  const memory = new Memory(join(f.dir, 'child-memory'), async () => 'Summary.', () => {});
  const children = new Children(memory, f.registry, () => choice, () => 'CHILD_PROFILE_RULES', async () => {}, () => {}, f.dir, { createSession: opts => createAgentSession({ ...opts, modelRuntime: f.runtime }) });
  try {
    await session.bindExtensions({});
    await session.prompt('Remember synthetic phrase: beige heron 814.');
    await session.prompt('What was the phrase?');
    assert.ok(f.requests.filter(r => r.cache !== 'none').length >= 2, 'both main turns reached the provider');
    const entry: string = 'pi-claude-bridge/src/index.ts';
    const upstream: { __test: { promptCaptures: { resolveOrDerive(prompt: string): { custom?: string; contextFiles: { content: string }[]; skills: { name: string }[] } } } } = await import(entry);
    const captureEntry: string = 'pi-claude-bridge/src/prompt-capture.ts';
    const { projectPromptCapture }: { projectPromptCapture(capture: unknown, options: { skillReadTool: string }): string | undefined } = await import(captureEntry);
    for (const request of f.requests.filter(r => r.cache !== 'none')) {
      const prompt = getCurrentSystemPrompt(request.context.messages);
      const capture = upstream.__test.promptCaptures.resolveOrDerive(prompt);
      assert.match(capture.custom ?? '', /PROFILE_RULES/);
      const projected = projectPromptCapture(capture, { skillReadTool: 'mcp' }) ?? '';
      assert.ok(projected.indexOf('REPO_RULES') < projected.indexOf('PROFILE_RULES'), 'profile rules follow repository rules in the actual SDK projection');
      assert.ok(projected.includes('FIXTURE_SKILL'), 'skill instructions reach the actual SDK projection');
      assert.ok(capture.contextFiles.some(file => file.content.includes('REPO_RULES')));
      assert.ok(capture.skills.some(skill => skill.name === 'fixture'));
      assert.match(textContent(request.context.messages.find(m => m.role === 'user')?.content), /<chat>/);
    }
    const boundary = f.requests.length;
    await children.spawn([{ task: 'Read synthetic memory' }], f.dir);
    const deadline = Date.now() + 10000;
    while (children.active) { assert.ok(Date.now() < deadline, 'child timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
    const child = f.requests.slice(boundary).find(r => r.cache !== 'none');
    assert.ok(child);
    const capture = upstream.__test.promptCaptures.resolveOrDerive(getCurrentSystemPrompt(child.context.messages));
    assert.match(capture.custom ?? '', /CHILD_PROFILE_RULES/);
    assert.ok(capture.contextFiles.some(file => file.content.includes('REPO_RULES')));
    assert.ok(capture.skills.some(skill => skill.name === 'fixture'));
  } finally {
    await children.close(); await memory.close();
    await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose();
    if (oldEnabled === undefined) delete process.env.OPTCHAT_CLAUDE_BRIDGE; else process.env.OPTCHAT_CLAUDE_BRIDGE = oldEnabled;
    if (oldHome === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = oldHome;
  }
});
