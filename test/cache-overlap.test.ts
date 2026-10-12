import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCurrentSystemMessage } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRegistry, ModelRuntime, SessionManager, SettingsManager, type ExtensionFactory } from '@earendil-works/pi-coding-agent';
import optchat from '../src/index.ts';
import { createCompressor } from '../src/compactor.ts';
import { Memory } from '../src/memory.ts';
import { createProfile, loadConfig, profilePath, saveConfig } from '../src/profiles.ts';
import type { RequestPrefix } from '../src/prefix.ts';
import { removeDir } from './support.ts';

async function until(check: () => boolean) {
  const end = Date.now() + 10000;
  while (!check()) { if (Date.now() > end) throw new Error('Timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
}

for (const first of ['main', 'compaction', 'cancelled-main'] as const) test(`native cache overlap: ${first}`, { timeout: 20000 }, async () => {
  const calls: { role: string; start: () => void; finish: () => void; prefix: string }[] = [];
  let counted = 0;
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (req.url?.includes('count_tokens')) {
      counted++; res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ input_tokens: 10000 })); return;
    }
    const role = JSON.stringify(body.messages).includes('Compaction:') ? 'compaction' : 'main';
    const send = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders();
    calls.push({ role, prefix: JSON.stringify([body.system, body.tools]), start: () => {
      send('message_start', { message: { id: role, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, usage: { input_tokens: 10000, output_tokens: 0 } } });
    }, finish: () => {
      send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
      send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Answer.' } }); send('content_block_stop', { index: 0 });
      send('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }); send('message_stop', {}); res.end();
    } });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const dir = mkdtempSync(join(tmpdir(), 'oc-overlap-')), oldHome = process.env.OPTCHAT_HOME;
  process.env.OPTCHAT_HOME = join(dir, 'home');
  let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined;
  const controller = new AbortController();
  let compaction: Promise<string> | undefined, main: Promise<void> | undefined;
  try {
    createProfile('fixture');
    const choice = { provider: 'fixture', model: 'claude-sonnet-5-5', thinking: 'off' as const };
    saveConfig(profilePath('fixture'), { ...loadConfig(profilePath('fixture')), compactor: choice, previousExchange: false });
    const memory = new Memory(profilePath('fixture'), async () => 'Summary.', () => {});
    for (let i = 0; i < 160; i++) memory.append('user', `Decision ${i}: ${'retained evidence '.repeat(8)}`);
    await memory.settle(undefined, 'tree'); await memory.close();
    const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false });
    runtime.registerProvider('fixture', { baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, apiKey: 'synthetic', api: 'anthropic-messages',
      models: [{ id: choice.model, name: 'Fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 1000 }] });
    let prefix: RequestPrefix | undefined, view = '';
    const compress = createCompressor(new ModelRegistry(runtime), () => choice, undefined, undefined, () => prefix!);
    const launch = () => {
      compaction = compress({ context: view, source: 'long source '.repeat(100), part: { l: 0, i: 0 } }, controller.signal);
      void compaction.catch(() => {});
    };
    const before: ExtensionFactory = pi => { pi.on('before_provider_request', async () => {
      if (first !== 'main' && !compaction) { launch(); await until(() => calls.length === 1); }
    }); };
    const after: ExtensionFactory = pi => { pi.on('context_with_system', event => {
      prefix = { system: structuredClone(getCurrentSystemMessage(event.messages)!), runtime: '' };
      const user = event.messages.find(message => message.role === 'user');
      if (user?.role === 'user' && Array.isArray(user.content) && user.content[0]?.type === 'text') view = user.content[0].text;
    }); };
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } });
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, 'agent'), settingsManager, noExtensions: true, noSkills: true, noContextFiles: true,
      extensionFactories: [before, optchat, after] });
    await loader.reload();
    ({ session } = await createAgentSession({ cwd: dir, resourceLoader: loader, modelRuntime: runtime, model: runtime.getModel('fixture', choice.model), settingsManager,
      sessionManager: SessionManager.create(dir, join(dir, 'sessions')), tools: [] }));
    session.extensionRunner.setFlagValue('optchat-profile', 'fixture'); await session.bindExtensions({ mode: 'print' });
    main = session.prompt('A short new message'); void main.catch(() => {});
    await until(() => calls.length === 1);
    if (first === 'main') launch();
    await until(() => counted > 0);
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.deepEqual(calls.map(call => call.role), [first === 'main' ? 'main' : 'compaction'], 'HTTP response headers do not release the follower');
    if (first === 'cancelled-main') {
      await session.abort(); await main;
      assert.equal(calls.length, 1, 'cancelled main never reaches the provider');
      calls[0].start(); calls[0].finish(); await compaction; return;
    }
    calls[0].start(); await until(() => calls.length === 2);
    assert.equal(calls[0].prefix, calls[1].prefix);
    calls[1].start(); calls.forEach(call => call.finish());
    await Promise.all([main, compaction]);
    assert.equal(calls.length, 2, 'no keep-alive/model ping requests');
  } finally {
    controller.abort(); if (session) await session.abort();
    server.closeAllConnections(); await Promise.allSettled([main, compaction]);
    if (session) { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); }
    await new Promise<void>(resolve => server.close(() => resolve())); process.env.OPTCHAT_HOME = oldHome; removeDir(dir);
  }
});
