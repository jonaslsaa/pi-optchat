import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Type } from 'typebox';
import { createAssistantMessageEventStream, type AssistantMessage, type Context } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRegistry, ModelRuntime, SessionManager, SettingsManager, type ExtensionFactory } from '@earendil-works/pi-coding-agent';
import optchat from '../src/index.ts';
import { builtinExtensions } from '../src/agents.ts';
import { createProfile, loadConfig, profilePath, saveConfig } from '../src/profiles.ts';
import { PrefixTools, requestPrefix } from '../src/prefix.ts';
import { REPORT_TYPE } from '../src/transcript.ts';
import { createCompressor } from '../src/compactor.ts';
import { emptyUsage } from '../src/usage.ts';
import { removeDir } from './support.ts';

const policy = { previousExchange: false, memorySearch: false };
const constrained = { name: 'constrained', description: 'Provider metadata matters', parameters: Type.Object({ text: Type.String() }), constrainedSampling: { type: 'json_schema' as const, strict: 'require' as const } };

test('canonical tool deltas retain metadata, final loadout changes, and independent snapshots', () => {
  const state = new PrefixTools();
  state.loadout([constrained]);
  state.finalize([{ role: 'system', content: 'canonical', toolsAdded: [constrained], timestamp: 0 },
    { role: 'system', content: '', toolsRemoved: [{ name: 'constrained' }], toolsAdded: [{ ...constrained, name: 'replacement' }], timestamp: 0 }], 'rendered');
  state.loadout([constrained]);
  assert.equal(state.snapshot()[0].name, 'replacement', 'unchanged loadout must not undo finalized deltas');
  assert.deepEqual(state.snapshot()[0].constrainedSampling, constrained.constrainedSampling);
  const snapshot = requestPrefix(state.prompt('rendered'), 'profile', policy, state.snapshot());
  state.loadout([{ ...constrained, name: 'new' }]);
  assert.equal(snapshot.system.toolsAdded?.[0].name, 'replacement');
  assert.equal(state.prompt('new prompt'), 'new prompt', 'a changed prompt cannot reuse the old canonical prompt');
});

test('operational sections follow the view without stripping examples in stable instructions', () => {
  const example = '<cwd>\nexample belongs to project instructions\n</cwd>';
  const project = `<project_context>\n${example}\n</project_context>`;
  for (const prompt of [`Preamble\n\n${project}\n\n<cwd>\n/live/path\n</cwd>\n\n<date>\ntoday\n</date>`,
    { role: 'system' as const, content: 'Preamble', sections: { project_context: project, cwd: '<cwd>\n/live/path\n</cwd>', date: '<date>\ntoday\n</date>' }, timestamp: 0 }]) {
    const prefix = requestPrefix(prompt, 'Profile rules', policy, []);
    assert.ok(String(prefix.system.content).includes(example));
    assert.ok(!String(prefix.system.content).includes('/live/path'));
    assert.equal(prefix.runtime, '<cwd>\n/live/path\n</cwd>\n\n<date>\ntoday\n</date>');
  }
});

test('shortening retries retain the initial instructions, tools, model, credentials and size policy', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-snapshot-'));
  const prefix = requestPrefix('Initial instructions', 'Profile', policy, [constrained]);
  let accepted = 512, modelName = 'initial';
  const sent: { context: Context; model: string; key?: string }[] = [];
  try {
    const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false });
    runtime.registerProvider('fixture', { baseUrl: 'https://invalid.local', apiKey: 'initial-key', api: 'openai-completions',
      models: ['initial', 'changed'].map(id => ({ id, name: id, reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 })),
      streamSimple(model, context, options) {
        sent.push({ context: structuredClone(context), model: model.id, key: options?.apiKey });
        prefix.system.content = 'Changed instructions'; prefix.system.toolsAdded = []; accepted = 900; modelName = 'changed';
        const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 's'.repeat(sent.length === 1 ? 700 : 400) }], api: model.api,
          provider: model.provider, model: model.id, timestamp: 0, stopReason: 'stop', usage: emptyUsage() };
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => { stream.push({ type: 'done', reason: 'stop', message }); stream.end(); }); return stream;
      } });
    const compress = createCompressor(new ModelRegistry(runtime), () => ({ provider: 'fixture', model: modelName, thinking: 'off' }), undefined, () => accepted, () => prefix);
    assert.equal((await compress({ context: '<chat>\n\n</chat>', source: 'x'.repeat(1200), part: { l: 0, i: 0 } }, new AbortController().signal)).length, 400);
    assert.equal(sent.length, 2, 'updated tolerance must not skip the retry');
    assert.deepEqual(sent[1].context.messages[0], sent[0].context.messages[0]);
    assert.equal(sent[1].context.messages.length, 4, 'retry continues the same conversation');
    for (const call of sent) { assert.equal(call.model, 'initial'); assert.equal(call.key, 'initial-key'); }
  } finally { removeDir(dir); }
});

async function until(check: () => boolean) {
  const end = Date.now() + 10000;
  while (!check()) { if (Date.now() > end) throw new Error('Timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
}

test('real Anthropic payloads share the entire tools/system prefix across turns, compactions, reports and reloads with MCP', { timeout: 30000 }, async () => {
  // These are the HTTP bodies after the actual SDK serializer and OptChat payload hook.
  const bodies: { system: unknown; tools: { name: string; strict?: boolean }[]; messages: { role: string; content: unknown }[] }[] = [];
  let invalid = true, executions = 0;
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()); bodies.push(body);
    const compaction = JSON.stringify(body.messages).includes('Compaction:');
    const toolCall = compaction && invalid; if (toolCall) invalid = false;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    send('message_start', { message: { id: `reply-${bodies.length}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
    send('content_block_start', { index: 0, content_block: toolCall ? { type: 'tool_use', id: 'forbidden', name: 'constrained', input: {} } : { type: 'text', text: '' } });
    send('content_block_delta', { index: 0, delta: toolCall ? { type: 'input_json_delta', partial_json: '{"text":"do not execute"}' } : { type: 'text_delta', text: compaction ? 'Summary.' : 'Answer.' } });
    send('content_block_stop', { index: 0 });
    send('message_delta', { delta: { stop_reason: toolCall ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } });
    send('message_stop', {}); res.end();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const dir = mkdtempSync(join(tmpdir(), 'oc-prefix-')), agentDir = join(dir, 'agent');
  const oldHome = process.env.OPTCHAT_HOME, oldAgent = process.env.PI_CODING_AGENT_DIR;
  process.env.OPTCHAT_HOME = join(dir, 'home'); process.env.PI_CODING_AGENT_DIR = agentDir;
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, 'AGENTS.md'), 'GLOBAL-INSTRUCTIONS');
  writeFileSync(join(dir, 'AGENTS.md'), 'PROJECT-INSTRUCTIONS\n<cwd>\nexample, keep this\n</cwd>');
  const skill = join(agentDir, 'skills', 'fixture'); mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, 'SKILL.md'), '---\nname: fixture\ndescription: SKILL-INSTRUCTIONS\n---\nSkill body');
  writeFileSync(join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: { fake: { command: process.execPath, args: [resolve(import.meta.dirname, 'fixtures/fake-mcp.mjs')], exposure: 'direct' } } }));
  let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined;
  let version = 'ONE'; const errors: string[] = [];
  try {
    createProfile('fixture');
    saveConfig(profilePath('fixture'), { ...loadConfig(profilePath('fixture')), ...policy, compactor: { provider: 'fixture', model: 'fixture', thinking: 'off' } });
    writeFileSync(join(profilePath('fixture'), 'AGENTS.md'), 'PROFILE-INSTRUCTIONS-ONE');
    const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false });
    runtime.registerProvider('fixture', { baseUrl: `http://127.0.0.1:${port}`, apiKey: 'synthetic', api: 'anthropic-messages',
      models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 1000, compat: { supportsStrictTools: true } }] });
    const later: ExtensionFactory = pi => {
      pi.on('before_agent_start', event => { event.systemPromptOptions.sections.later = `LATER-INSTRUCTIONS-${version}`; event.systemPromptOptions.sections.date = 'DYNAMIC-DATE'; });
      pi.registerTool({ ...constrained, label: 'Constrained', description: `${constrained.description}-${version}`, execute: async () => { executions++; return { content: [], details: {} }; } });
    };
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } });
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir, settingsManager, noPromptTemplates: true,
      extensionFactories: [optchat, ...builtinExtensions(['mcp']), later], appendSystemPrompt: ['USER-ADDENDUM'] });
    await loader.reload();
    ({ session } = await createAgentSession({ cwd: dir, modelRuntime: runtime, model: runtime.getModel('fixture', 'fixture'), resourceLoader: loader, settingsManager, sessionManager: SessionManager.create(dir, join(dir, 'sessions')) }));
    session.extensionRunner.setFlagValue('optchat-profile', 'fixture');
    await session.bindExtensions({ mode: 'print', onError: error => { errors.push(error.error); } });
    await session.prompt('First input. '.repeat(90));
    await session.prompt('Second input. '.repeat(90));
    await until(() => bodies.filter(b => JSON.stringify(b.messages).includes('Compaction:')).length >= 3);
    await session.sendCustomMessage({ customType: REPORT_TYPE, content: '[123abc] REPORT-TURN', display: true }, { triggerTurn: true });
    await until(() => !session!.isStreaming && bodies.some(b => JSON.stringify(b.messages).includes('REPORT-TURN')));
    const prefix = JSON.stringify([bodies[0].tools, bodies[0].system]);
    for (const body of bodies) assert.equal(JSON.stringify([body.tools, body.system]), prefix, 'all serialized tools/system bytes match');
    for (const marker of ['GLOBAL-INSTRUCTIONS', 'PROJECT-INSTRUCTIONS', 'SKILL-INSTRUCTIONS', 'USER-ADDENDUM', 'PROFILE-INSTRUCTIONS-ONE', 'LATER-INSTRUCTIONS-ONE', 'example, keep this']) assert.ok(prefix.includes(marker), marker);
    assert.ok(bodies[0].tools.some(t => t.name === 'mcp__fake__echo'), 'real MCP declaration survives');
    assert.equal(bodies[0].tools.find(t => t.name === 'constrained')?.strict, true, 'provider constraint survives serialization');
    assert.ok(!prefix.includes('DYNAMIC-DATE'));
    for (const body of bodies) {
      const text = JSON.stringify(body.messages);
      assert.ok(text.indexOf('</chat>') < text.indexOf('DYNAMIC-DATE'), 'runtime state follows view');
    }
    assert.equal(executions, 0, 'compactor tool calls are rejected without execution');
    const before = bodies.length;
    version = 'TWO'; writeFileSync(join(profilePath('fixture'), 'AGENTS.md'), 'PROFILE-INSTRUCTIONS-TWO');
    await session.reload();
    await session.prompt('New configuration. '.repeat(90));
    await session.prompt('Wait for new summaries');
    const changed = bodies.slice(before), newPrefix = JSON.stringify([changed[0].tools, changed[0].system]);
    assert.notEqual(newPrefix, prefix);
    assert.ok(newPrefix.includes('PROFILE-INSTRUCTIONS-TWO') && newPrefix.includes('LATER-INSTRUCTIONS-TWO'));
    assert.ok(!newPrefix.includes('PROFILE-INSTRUCTIONS-ONE') && !newPrefix.includes('LATER-INSTRUCTIONS-ONE'));
    assert.ok(changed.some(b => JSON.stringify(b.messages).includes('Compaction:')));
    for (const body of changed) assert.equal(JSON.stringify([body.tools, body.system]), newPrefix);
    assert.deepEqual(errors, []);
  } finally {
    if (session) { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); }
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    process.env.OPTCHAT_HOME = oldHome; process.env.PI_CODING_AGENT_DIR = oldAgent; removeDir(dir);
  }
});
