import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Memory, SOURCE_BYTES, CAP, bytes, splitText, logicalEntries, type Entry, type Compression, type Kind } from '../src/memory.ts';
import { FileStore, type Store } from '../src/store.ts';
import { Inbox } from '../src/inbox.ts';
import { logMessage, buildContext, textContent, reportReceipt } from '../src/transcript.ts';
import { prepareImport, runImport, memoryDirectory, deduplicate } from '../src/import/job.ts';
import { emptyUsage } from '../src/usage.ts';
import { removeDir } from './support.ts';
import { createAssistantMessageEventStream, type AssistantMessage, type UserMessage } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import optchat from '../src/index.ts';
import { createProfile, loadConfig, profilePath, saveConfig } from '../src/profiles.ts';
import { COMPACT } from '../src/prompts.ts';

const temp = () => mkdtempSync(join(tmpdir(), 'optchat-chunks-'));
const date = '2026-10-12T12:34:56.000Z';
const origin = { source: 'claude' as const, conversation: 'session', message: 'message', title: 'Imported note' };
const short = async () => 'summary';
const tick = () => new Promise(resolve => setImmediate(resolve));

test('source chunks reconstruct exact ASCII, multibyte, newlines and boundary surrogate pairs within 30,000 UTF-8 bytes', () => {
  for (const text of ['', 'a'.repeat(1_000_000), '字'.repeat(30_000), 'a'.repeat(SOURCE_BYTES - 1) + '😀\r\n'.repeat(9000),
    '\n'.repeat(SOURCE_BYTES + 1), 'abc\r\n'.repeat(20_000), '\ud800'.repeat(SOURCE_BYTES)]) {
    const chunks = splitText(text);
    assert.equal(chunks.join(''), text);
    for (const chunk of chunks) {
      assert.ok(bytes(chunk) <= SOURCE_BYTES);
      if (text.isWellFormed()) assert.ok(chunk.isWellFormed());
    }
  }
});

test('every non-result writer chunks its history while current input and actual tool calls stay whole', async () => {
  const dir = temp(), calls: Compression[] = [];
  const memory = new Memory(dir, async input => { calls.push(input); return 'summary'; }, () => {});
  try {
    const text = 'a'.repeat(1_000_000), view = memory.render();
    const user: UserMessage = { role: 'user', content: text, timestamp: Date.parse(date) };
    logMessage(memory, user, 'input');
    const projected = buildContext([user], [user], view, 'instructions');
    assert.ok(projected[1].role === 'user');
    assert.ok(textContent(projected[1].content).endsWith(text));
    const assistant: AssistantMessage = { role: 'assistant', timestamp: Date.parse(date), stopReason: 'toolUse',
      api: 'openai-completions', provider: 'fixture', model: 'fixture', usage: emptyUsage(), content: [
        { type: 'thinking', thinking: 'secret' }, { type: 'text', text: 'reply '.repeat(6000) },
        { type: 'toolCall', id: 'a', name: 'first', arguments: { source: 'A'.repeat(70_000) } },
        { type: 'toolCall', id: 'b', name: 'second', arguments: { source: 'B'.repeat(65_000) } },
      ] };
    const original = structuredClone(assistant);
    logMessage(memory, assistant);
    for (const [toolName, toolCallId] of [['first', 'a'], ['second', 'b']]) logMessage(memory, {
      role: 'toolResult', toolName, toolCallId, timestamp: Date.parse(date), isError: false,
      content: [{ type: 'text', text: 'result '.repeat(8000) }],
    });
    const report = '[Child] ' + 'evidence '.repeat(9000), receipt = reportReceipt(report);
    logMessage(memory, { ...user, content: report }, receipt);
    memory.append('note', 'historical '.repeat(8000), date, 'import:note', origin);
    await memory.durable();
    await memory.settle(AbortSignal.timeout(5000), 'tree');
    assert.deepEqual(assistant, original);
    const logical = logicalEntries(memory.root);
    assert.deepEqual(logical.map(e => e.kind), ['user', 'talk', 'tool', 'tool', 'echo', 'echo', 'work', 'note']);
    assert.equal(logical[0].text, text);
    assert.equal(logical[6].text, report);
    assert.match(memory.zoom(logical[6].i + 1, 1), /chunk 2\/3; logical message spans IDs/);
    for (const [index, name] of [[2, 'first'], [3, 'second']] as const) {
      const block = original.content[index]; assert.ok(block.type === 'toolCall');
      assert.equal(logical[index].text, `${name} ${JSON.stringify(block.arguments)}`);
      const result = logical[index + 2];
      assert.ok(result.text.length <= CAP);
      assert.equal(calls.find(c => !c.part.l && c.part.i === result.i)?.call?.text.startsWith(`tool: ${name} `), true);
      assert.equal(calls.find(c => !c.part.l && c.part.i === result.i)?.call?.i, logical[index].i);
    }
    assert.ok(calls.filter(c => !c.part.l && memory.root[c.part.i].kind !== 'echo').every(c => bytes(c.source) <= SOURCE_BYTES + 6));
    assert.equal(memory.root.filter(e => e.receipt === 'input').length, 1);
    assert.ok(memory.root.filter(e => e.kind === 'work').every(e => e.chunk?.id === memory.root.find(e => e.kind === 'work')!.chunk?.id));
    assert.ok(memory.root.filter(e => e.kind === 'note').every(e => JSON.stringify(e.origin) === JSON.stringify(origin) && e.date === date));
    assert.doesNotMatch(JSON.stringify(memory.root), /secret/);
  } finally { await memory.close(); removeDir(dir); }
});

test('restart finishes each interrupted chunk boundary once, with and without an inbox receipt', async () => {
  for (const kind of ['user', 'talk', 'tool', 'work', 'note'] as Kind[]) {
    const text = (kind === 'work' ? '[Child] ' : '') + '字😀\n'.repeat(12_000), count = splitText(text).length;
    for (let cut = 0; cut <= count; cut++) {
      const dir = temp();
      class Interrupted extends FileStore {
        appended = 0;
        override append(e: Entry): undefined {
          if (this.appended === cut) throw new Error('interrupted');
          super.append(e); this.appended++; return undefined;
        }
        override savePending(entries: readonly Entry[] | undefined): undefined {
          if (!entries && cut === count) throw new Error('interrupted before intent cleanup');
          return super.savePending(entries);
        }
      }
      const store = new Interrupted(dir), saved = store.load(), inbox = new Inbox(dir);
      const receipt = kind === 'user' ? inbox.record(text) : kind === 'work' ? reportReceipt(text) : undefined;
      let memory = new Memory({ directory: dir, store, saved }, short, () => {});
      try {
        assert.throws(() => memory.append(kind, text, date, receipt, origin), /interrupted/);
        await memory.close();
        const before = new FileStore(dir).load().entries as Entry[];
        assert.equal(before.length, cut);
        if (cut < count) assert.equal(before.some(e => e.receipt), false);
        memory = await Memory.open(dir, short, () => {});
        assert.equal(memory.root.length, count);
        assert.equal(memory.root.map(e => e.text).join(''), text);
        assert.deepEqual(memory.root.slice(0, cut), before);
        assert.ok(memory.root.every(e => e.kind === kind && e.date === date && JSON.stringify(e.origin) === JSON.stringify(origin)));
        assert.equal(await new Inbox(dir).recover(memory), 0);
        assert.equal(memory.root.length, count);
        await memory.close();
        memory = await Memory.open(dir, short, () => {});
        assert.equal(memory.root.length, count);
      } finally { await memory.close(); removeDir(dir); }
    }
  }
});

test('async storage cannot acknowledge an input before its last chunk lands, and a failed suffix remains recoverable', async () => {
  for (const fail of [false, true]) {
    const dir = temp(), base = new FileStore(dir), saved = base.load();
    const inbox = new Inbox(dir), text = 'long input '.repeat(8000), receipt = inbox.record(text);
    let release!: () => void, atLast = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const store: Store = {
      load: () => base.load(), savePending: async entries => { base.savePending(entries); },
      append: async entry => {
        if (entry.receipt) { atLast = true; await gate; if (fail) throw new Error('offline'); }
        base.append(entry);
      },
      appendNode: async node => { base.appendNode(node); }, saveView: async view => { base.saveView(view); },
      putImage: (...args) => base.putImage(...args), image: name => base.image(name),
    };
    let memory = new Memory({ directory: dir, store, saved }, short, () => {});
    try {
      const recovering = inbox.recover(memory);
      for (let i = 0; !atLast && i < 100; i++) await tick();
      assert.equal(atLast, true);
      assert.equal(memory.hasReceipt(receipt), false);
      assert.equal(JSON.parse(readFileSync(join(dir, 'pending-inputs.json'), 'utf8')).length, 1);
      release();
      if (fail) {
        await assert.rejects(recovering, /offline/);
        assert.equal(JSON.parse(readFileSync(join(dir, 'pending-inputs.json'), 'utf8')).length, 1);
        await memory.close(); memory = await Memory.open(dir, short, () => {});
        assert.equal(await new Inbox(dir).recover(memory), 0);
      } else assert.equal(await recovering, 1);
      assert.equal(memory.hasReceipt(receipt), true);
      assert.equal(JSON.parse(readFileSync(join(dir, 'pending-inputs.json'), 'utf8')).length, 0);
      assert.equal(memory.root.map(e => e.text).join(''), text);
    } finally { release(); await memory.close(); removeDir(dir); }
  }
});

test('imports chunk notes before staging and preserve provenance, deduplication and originals across activation', async () => {
  const dir = temp(); let memory = new Memory(dir, short, () => {});
  try {
    memory.append('user', 'native'); await memory.settle(undefined, 'tree'); await memory.close();
    const note = { kind: 'note' as const, date, text: '[Historical]\n' + 'retained detail '.repeat(7000), receipt: 'import:long-note', origin };
    const job = prepareImport(dir, memory, [note], 'append')!;
    assert.ok(job.total > 2);
    // Interrupt after the first staged chunk was flushed, before its suffix. runImport must resume this same group.
    const path = join(dir, job.target), stage = readFileSync(join(path, 'staged.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as Entry);
    const interrupted = new FileStore(path); interrupted.load();
    interrupted.savePending(stage.slice(1)); interrupted.append(stage[1]);
    assert.equal(memoryDirectory(dir), dir, 'activation still points at the original memory');
    await runImport(dir, short, AbortSignal.timeout(5000));
    memory = await Memory.open(memoryDirectory(dir), short, () => {});
    assert.equal(memory.root[0].text, 'native');
    assert.equal(memory.root.slice(1).map(e => e.text).join(''), note.text);
    assert.deepEqual(deduplicate(memory.root, [note]), { added: [], skipped: 1 });
    assert.deepEqual(deduplicate(memory.root, [{ ...note, receipt: 'import:copy', origin: { ...origin, conversation: 'fork' } }]), { added: [], skipped: 1 });
    assert.ok(memory.root.slice(1).every(e => bytes(e.text) <= SOURCE_BYTES && e.origin?.message === origin.message));
  } finally { await memory.close(); removeDir(dir); }
});

test('queued async logical messages serialize intent, chunks and completion before replacing recovery data', async () => {
  const dir = temp(), base = new FileStore(dir), saved = base.load(), operations: string[] = [];
  const store: Store = {
    load: () => base.load(),
    savePending: async entries => { await tick(); base.savePending(entries); operations.push(entries ? `intent:${entries[0].kind}` : 'complete'); },
    append: async entry => { await tick(); base.append(entry); operations.push(`${entry.kind}:${entry.chunk?.index}`); },
    appendNode: node => base.appendNode(node), saveView: view => base.saveView(view),
    putImage: (...args) => base.putImage(...args), image: name => base.image(name),
  };
  const memory = new Memory({ directory: dir, store, saved }, short, () => {});
  try {
    memory.append('user', 'x'.repeat(60_001), date, 'user-receipt');
    memory.append('work', '[Child] ' + 'y'.repeat(60_001), date, 'report-receipt');
    assert.equal(memory.hasReceipt('user-receipt'), false);
    await memory.durable();
    assert.equal(memory.hasReceipt('report-receipt'), true);
    assert.deepEqual(operations, ['intent:user', 'user:0', 'user:1', 'user:2', 'complete', 'intent:work', 'work:0', 'work:1', 'work:2', 'complete']);
    assert.equal(base.load().pending, null);
  } finally { await memory.close(); removeDir(dir); }
});

test('a conflicting chunk recovery record is refused before any originals are changed', async () => {
  const dir = temp(), memory = new Memory(dir, short, () => {});
  try {
    memory.append('user', 'x'.repeat(60_001), date, 'receipt'); await memory.close();
    const store = new FileStore(dir), saved = store.load(), original = structuredClone(saved.entries);
    const broken = structuredClone(saved.entries) as Entry[];
    broken[0].text = 'different input';
    writeFileSync(join(dir, 'pending-message.json'), JSON.stringify(broken));
    assert.throws(() => new Memory(dir, short, () => {}), /Invalid pending/);
    assert.deepEqual(store.load().entries, original);
  } finally { await memory.close(); removeDir(dir); }
});

test('the real Pi request waits for durable chunks and sends the entire million-character current input', async () => {
  const dir = temp(), oldHome = process.env.OPTCHAT_HOME;
  process.env.OPTCHAT_HOME = dir;
  const text = 'x'.repeat(1_000_000), captured: string[] = [], errors: string[] = [];
  let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined;
  let release!: () => void, arrived!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), atLast = new Promise<void>(resolve => { arrived = resolve; });
  const append = FileStore.prototype.append;
  const patched = mock.method(FileStore.prototype, 'append', async function(this: FileStore, entry: Entry) {
    if (entry.kind === 'user' && entry.receipt) { arrived(); await gate; }
    return append.call(this, entry);
  });
  try {
    createProfile('fixture'); const profile = profilePath('fixture');
    saveConfig(profile, { ...loadConfig(profile), previousExchange: false, refreshAt: 0,
      compactor: { provider: 'chunk-fixture', model: 'fixture', thinking: 'off' } });
    const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null,
      modelsStorePath: join(dir, 'models-cache.json'), refreshOnCreate: false });
    runtime.registerProvider('chunk-fixture', {
      baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
      models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 2_000_000, maxTokens: 1000 }],
      streamSimple(model, context) {
        const compression = context.messages.some(m => m.role === 'system' && m.content === COMPACT);
        if (!compression) captured.push(textContent(context.messages.at(-1)?.content));
        const reply: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: compression ? 'summary' : 'Received.' }],
          timestamp: Date.now(), stopReason: 'stop', api: model.api, provider: model.provider, model: model.id, usage: emptyUsage() };
        const stream = createAssistantMessageEventStream(); stream.push({ type: 'done', reason: 'stop', message: reply }); stream.end(); return stream;
      },
    });
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } });
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, 'agent'), settingsManager,
      noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, extensionFactories: [optchat] });
    await loader.reload();
    const manager = SessionManager.inMemory(dir); manager.appendCustomEntry('optchat.profile', { name: 'fixture' });
    ({ session } = await createAgentSession({ modelRuntime: runtime, model: runtime.getModel('chunk-fixture', 'fixture'),
      resourceLoader: loader, settingsManager, sessionManager: manager, tools: ['zoom', 'date'] }));
    await session.bindExtensions({ onError: error => errors.push(error.error) });
    const running = session.prompt(text);
    await atLast;
    assert.equal(captured.length, 0, 'the main provider must wait for durability');
    assert.equal(JSON.parse(readFileSync(join(profile, 'pending-inputs.json'), 'utf8')).length, 1);
    release(); await running;
    assert.equal(captured.length, 1);
    assert.ok(captured[0].endsWith(text));
    assert.equal(JSON.parse(readFileSync(join(profile, 'pending-inputs.json'), 'utf8')).length, 0);
    assert.deepEqual(errors, []);
  } finally {
    release();
    await session?.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session?.dispose();
    patched.mock.restore();
    if (oldHome === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = oldHome;
    removeDir(dir);
  }
});
