import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRegistry, Harness } from '@earendil-works/pi-durable';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { NodeSqliteDatabase } from '@earendil-works/chord/sqlite/node';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type FauxResponseStep } from '@earendil-works/pi-ai/providers/faux';
import { openMemory, type Compressor, type ImageStore, type ImportedEntry, type Mime } from '../src/core/index.ts';
import { optchat, optchatImport, SqliteStore, withCacheMarks, type Read, type SqliteStoreOptions } from '../src/durable/index.ts';
import { importTables } from '../src/durable/store.ts';
import { imageRef } from '../src/images.ts';
import { removeDir } from './support.ts';

type Sent = { role: string; content: unknown }[];
const text = (content: unknown) => typeof content === 'string' ? content
  : (content as { type: string; text?: string }[]).map(block => block.text ?? `[${block.type}]`).join('');

/** One OptChat agent on Pi Durable, over one SQLite database as in a Durable Object: Pi's tables `pi_*`, memory's `optchat_*`. */
/** `importing` builds an import's summaries (`compress` by default). */
async function open(file: string, replies: FauxResponseStep[], compress: Compressor = async ({ part }) => `line ${part.l}/${part.i}`,
  { contextWindow, images, importing = compress }: { contextWindow?: number; importing?: Compressor } & SqliteStoreOptions = {}) {
  const sync = new DatabaseSync(file), db = new NodeSqliteDatabase(sync);
  const faux = fauxProvider(contextWindow ? { models: [{ id: 'small', contextWindow }] } : {}), models = createModels();
  models.setProvider(faux.provider);
  const sent: Sent[] = [];
  faux.setResponses(replies.map(reply => (request, ...rest) => {
    sent.push(request.messages.map(m => ({ role: m.role, content: 'content' in m ? m.content : undefined })));
    return typeof reply === 'function' ? reply(request, ...rest) : reply;
  }));
  const query: Read = (sql, ...params) => sync.prepare(sql).iterate(...params);
  const memory = await openMemory(new SqliteStore(db, query, { images }), compress);
  const memoryExtension = optchat({ memory });
  // Resolves when an import goes live, and rejects when a task fails, so a failed import doesn't leave a test waiting.
  let activate = () => {}, fault = (_: unknown) => {};
  const activated = new Promise<void>((resolve, reject) => { activate = resolve; fault = reject; });
  activated.catch(() => {});
  /** The view each import's memory loaded. */
  const loaded: (string | undefined)[] = [];
  const importer = optchatImport({ memory, db, read: query, onActivated: () => activate(), open: generation => {
    const store = new SqliteStore(db, query, { images, generation }), load = store.load.bind(store);
    store.load = async () => { const saved = await load(); loaded.push(saved.view); return saved; };
    return openMemory(store, importing, { jobs: 4 });
  } });
  const registry = createRegistry();
  registry.install(memoryExtension.extension);
  registry.install(importer.extension);
  const harness = await Harness.open(await SqliteStorage.open(db, { prefix: 'pi_' }),
    { models: withCacheMarks(models), registry, settings: { compaction: { enabled: false }, afterFailedRun: 'continue' },
      onReport: (error, info) => { if (info.type === 'task_faulted' || info.type === 'task_parked') fault(error); } }, context);
  const root = await harness.root(context, { agent: { model: { provider: faux.provider.id, modelId: faux.getModel().id } } });
  memoryExtension.attach(harness, context);
  importer.attach(harness, context);
  // A reopened Harness runs owed tasks once resumed, as PiHarness does when it opens.
  harness.resume();
  /** Answers an input, then waits until OptChat has reset the context and logged the run. */
  const ask = async (content: string) => {
    const answer = await (await root.submit({ type: 'input', content }, context)).wait(context);
    await idle();
    return answer;
  };
  /** Until OptChat has reset the context and its background task has logged the run: waitForIdle leaves background tasks out. */
  const idle = async () => {
    const remembering = async () => (await root.context(context)).entries.some(e => e.kind !== 'pi.reset')
      || (await harness.inspect(context)).tasks.some(task => task.record.kind === 'optchat.remember');
    while (await remembering()) await new Promise(resolve => setImmediate(resolve));
    await memory.settle();
  };
  const close = async () => { await harness.close(context); await memory.close(); await db.close(); };
  const keptInSqlite = () => sync.prepare('SELECT count(*) AS n FROM optchat_images').get()?.n;
  return { memory, root, sent, ask, idle, close, keptInSqlite, harness, importer, activated, loaded, db, query, sql: sync };
}
// A test may close a database and open it again, so the folders go once every test is done.
const dirs: string[] = [];
after(() => dirs.forEach(removeDir));
const read = (n: number) => fauxAssistantMessage(fauxToolCall('date', { id: n }), { stopReason: 'toolUse' });
const file = () => { const dir = mkdtempSync(join(tmpdir(), 'optchat-durable-')); dirs.push(dir); return join(dir, 'agent.sqlite'); };

test('each request is the view, the previous exchange and the current context; what a reset ended is in memory', async () => {
  const agent = await open(file(), [
    fauxAssistantMessage('Hi Jonas'),
    fauxAssistantMessage(fauxToolCall('date', { id: 0 }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('You said hello first.'),
  ]);
  try {
    await agent.ask('hello');
    await agent.ask('what did I say first?');
    assert.deepEqual(agent.memory.entries().map(e => `${e.kind}: ${e.text.split(' GMT')[0]}`), [
      'user: hello', 'talk: Hi Jonas', 'user: what did I say first?', 'tool: date {"id":0}',
      `echo: date: ${new Date(agent.memory.root[0].date).toString().split(' GMT')[0]}`, 'talk: You said hello first.',
    ]);
    const [, toolCall, afterTool] = agent.sent.map(request => request.filter(m => m.role !== 'system').map(m => `${m.role}: ${text(m.content)}`));
    // The view goes before the previous exchange, whose answer is replayed; Pi's own transcript is gone after the reset.
    assert.deepEqual(toolCall, ['user: <chat>\n0+1|user: hello\n1+1|talk: Hi Jonas\n</chat>\n\nhello', 'assistant: Hi Jonas', 'user: what did I say first?']);
    // The view stays the same within a context, so the request after a tool call reads it from the cache.
    assert.deepEqual(afterTool.slice(0, 3), toolCall);
    assert.deepEqual(afterTool.slice(3).map(line => line.split(':')[0]), ['assistant', 'toolResult']);
    assert.deepEqual((await agent.root.context(context)).entries.map(e => e.kind), ['pi.reset']);
  } finally { await agent.close(); }
});

test('the previous exchange is the last run alone, in a context where a run failed', async () => {
  const failed = fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'Invalid request' });
  // B is queued behind A (and runs after A fails too: afterFailedRun), so both runs are in one context when it is reset; then C is asked.
  const sentBeforeC = async (first: FauxResponseStep, second: FauxResponseStep) => {
    const agent = await open(file(), [first, second, fauxAssistantMessage('C1')]);
    try {
      const a = await agent.root.submit({ type: 'input', content: 'A' }, context), b = await agent.root.submit({ type: 'input', content: 'B' }, context);
      await a.wait(context); await b.wait(context); await agent.idle();
      await agent.ask('C');
      return agent.sent[2].filter(m => m.role !== 'system').map(m => text(m.content).split('</chat>\n\n').at(-1));
    } finally { await agent.close(); }
  };
  // B failed: A's run is not the previous one, so none is sent.
  assert.deepEqual(await sentBeforeC(fauxAssistantMessage('A1'), failed), ['C']);
  // A failed: B's run is sent without A's input.
  assert.deepEqual(await sentBeforeC(failed, fauxAssistantMessage('B1')), ['B', 'B1', 'C']);
});

test('an input queued behind a run keeps its context: the context is reset only once the conversation is idle', async () => {
  const agent = await open(file(), [fauxAssistantMessage('first answer'), fauxAssistantMessage('second answer')]);
  try {
    const first = await agent.root.submit({ type: 'input', content: 'one' }, context);
    const second = await agent.root.submit({ type: 'input', content: 'two' }, context);
    assert.equal((await first.wait(context)).status, 'done');
    assert.equal((await second.wait(context)).status, 'done');
    await agent.idle();
    // The follow-up ran right after the first answer, in the same context: it sees that run in full.
    assert.deepEqual(agent.sent[1].filter(m => m.role !== 'system').map(m => text(m.content)), ['<chat>\n\n</chat>\n\none', 'first answer', 'two']);
    assert.deepEqual(agent.memory.entries().map(e => e.text), ['one', 'first answer', 'two', 'second answer']);
  } finally { await agent.close(); }
});

test('reopened on the same database, memory logs nothing twice and makes no summary calls', async () => {
  const path = file(), long = (s: string) => `${s} ${'detail '.repeat(100)}`;
  let calls = 0;
  const compress: Compressor = async ({ part }) => { calls++; return `line ${part.l}/${part.i}`; };
  const before = await open(path, [fauxAssistantMessage(long('answer one')), fauxAssistantMessage(long('answer two'))], compress);
  await before.ask(long('question one'));
  await before.ask(long('question two'));
  const logged = before.memory.entries().map(e => e.text);
  await before.close();
  assert.ok(calls > 0);
  calls = 0;
  const after = await open(path, [fauxAssistantMessage('answer three')], compress);
  try {
    assert.equal(calls, 0);
    await after.ask('question three');
    assert.deepEqual(after.memory.entries().map(e => e.text), [...logged, 'question three', 'answer three']);
  } finally { await after.close(); }
});

test('reopened before the run was remembered, memory logs that run once, after the runs it has', async () => {
  const path = file();
  const before = await open(path, [fauxAssistantMessage('answer one'), fauxAssistantMessage('answer two')]);
  await before.ask('question one');
  // Closed as soon as the second run is answered: whether its reset or its logging began is up to timing, and either must do.
  await (await before.root.submit({ type: 'input', content: 'question two' }, context)).wait(context);
  await before.close();
  const after = await open(path, []);
  try {
    await after.idle();
    assert.deepEqual(after.memory.entries().map(e => e.text), ['question one', 'answer one', 'question two', 'answer two']);
  } finally { await after.close(); }
});

test('an entry cut off between its records is completed on reopen, without logging its saved records twice', async () => {
  const path = file();
  const before = await open(path, [
    fauxAssistantMessage([fauxText('Let me check.'), fauxToolCall('date', { id: 0 })], { stopReason: 'toolUse' }), fauxAssistantMessage('It was today.'),
  ]);
  await before.ask('when did I first write?');
  const logged = before.memory.entries().map(e => `${e.kind}: ${e.text}`);
  await before.close();
  // The answer with a tool call made two records; as if the object died after saving the first, memory ends with it.
  const cut = logged.indexOf('talk: Let me check.') + 1, db = new DatabaseSync(path);
  db.exec(`DELETE FROM optchat_log WHERE i >= ${cut}; DELETE FROM optchat_tree; DELETE FROM optchat_view;`);
  db.close();
  const after = await open(path, [fauxAssistantMessage('Hello again.')]);
  try {
    assert.equal(after.memory.root.length, cut);
    await after.ask('hi');
    assert.deepEqual(after.memory.entries().map(e => `${e.kind}: ${e.text}`), [...logged, 'user: hi', 'talk: Hello again.']);
  } finally { await after.close(); }
});

test('a reset\'s note reaches the model once, and is in memory once, also after a restart', async () => {
  const path = file(), note = 'The code is 42.';
  const before = await open(path, [fauxAssistantMessage('Hi'), fauxAssistantMessage('42'), fauxAssistantMessage('Bye')]);
  await before.ask('hello');
  await before.root.reset(note, context);
  await before.ask('what is the code?');
  // Pi sends the note in the context it starts; the view, built before that context ended, does not have it.
  assert.equal(JSON.stringify(before.sent[1]).split(note).length - 1, 1);
  await before.ask('thanks');
  const notes = (memory: typeof before.memory) => memory.entries().filter(e => e.text.includes(note)).map(e => `${e.kind}: ${e.text}`);
  assert.deepEqual(notes(before.memory), [`user: [Handoff note] ${note}`]);
  // Now only in the view.
  assert.equal(JSON.stringify(before.sent[2]).split(note).length - 1, 1);
  await before.close();
  const after = await open(path, [fauxAssistantMessage('Hello again')]);
  try {
    await after.ask('hi');
    assert.deepEqual(notes(after.memory), [`user: [Handoff note] ${note}`]);
  } finally { await after.close(); }
});

test('after a save fails, requests still carry the view memory has, and a long run is sent whole', async () => {
  const agent = await open(file(), [...['one', 'two', 'three', 'four'].map(text => fauxAssistantMessage(`re ${text}`)),
    read(0), read(1), read(2), read(3), read(4), read(5), fauxAssistantMessage('done')], undefined, { contextWindow: 150 });
  try {
    await agent.ask('one');
    const { store } = agent.memory;
    store.append = async () => { throw new Error('database or disk is full: SQLITE_FULL'); };
    await agent.ask('two');
    assert.match(agent.memory.saveError ?? '', /SQLITE_FULL/);
    await agent.ask('three');
    // Memory refuses to log run three, yet the next request still gets the view, with what memory had in RAM.
    await agent.ask('four');
    const [first] = agent.sent[3].filter(m => m.role === 'user').map(m => text(m.content));
    assert.match(first, /^<chat>\n[^]*\|user: two\n[^]*<\/chat>/);
    // Past the refresh threshold, nothing is cut: memory couldn't keep the steps a refresh would drop.
    await agent.ask('read them all');
    assert.equal(agent.sent.at(-1)?.filter(m => m.role === 'toolResult').length, 6);
    assert.ok(agent.sent.every(request => !request.some(m => text(m.content).includes('this turn grew long'))));
  } finally { await agent.close(); }
});

const photo = { type: 'image' as const, mimeType: 'image/jpeg', data: Buffer.alloc(1000, 7).toString('base64') };
/** Asks with a photo, then has the model zoom into that message; returns what the model got back from the zoom. */
async function zoomIntoPhoto(agent: Awaited<ReturnType<typeof open>>) {
  await (await agent.root.submit({ type: 'input', content: [{ type: 'text', text: 'look' }, photo] }, context)).wait(context);
  await agent.idle();
  await agent.ask('show it again');
  const result = agent.sent.at(-1)?.find(m => m.role === 'toolResult');
  return Array.isArray(result?.content) ? result.content.filter(block => block.type === 'image') : [];
}
const zoomThenAnswer = () => [fauxAssistantMessage('nice'), fauxAssistantMessage(fauxToolCall('zoom', { id: 0 }), { stopReason: 'toolUse' }), fauxAssistantMessage('here')];

test('an image is named as in Pi, kept, named in the previous exchange, and zoom returns it', async () => {
  const agent = await open(file(), zoomThenAnswer());
  try {
    assert.deepEqual(await zoomIntoPhoto(agent), [photo]);
    assert.equal(agent.memory.text(0), `look\n${imageRef(photo)}`);
    assert.equal(agent.keptInSqlite(), 1);
    // The next request's previous exchange names the image instead of sending it again.
    assert.equal(text(agent.sent[1].find(m => m.role === 'user')?.content).split('</chat>\n\n')[1], `look\n${imageRef(photo)}`);
  } finally { await agent.close(); }
});

test('with an images store, images go there, and zoom reads them from it', async () => {
  const kept = new Map<string, { mimeType: Mime; data: Uint8Array }>();
  const images: ImageStore = { putImage: async (name, mimeType, data) => void kept.set(name, { mimeType, data }), image: name => kept.get(name) };
  const agent = await open(file(), zoomThenAnswer(), undefined, { images });
  try {
    assert.deepEqual(await zoomIntoPhoto(agent), [photo]);
    assert.deepEqual([...kept.keys()], [createHash('sha256').update(photo.data).digest('hex').slice(0, 16)]);
    assert.equal(agent.keptInSqlite(), 0);
  } finally { await agent.close(); }
});

test('cache marks go on an Anthropic request that carries the view; a request with its own onPayload is left alone', async () => {
  const faux = fauxProvider({ api: 'anthropic-messages' }), models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel(), request = { messages: [{ role: 'user' as const, content: 'hi', timestamp: 0 }] };
  // pi-ai's Models is a class instance: its other methods must still reach it through the wrapper.
  assert.equal(withCacheMarks(models).getModel(model.provider, model.id), model);
  let given: Parameters<typeof models.streamSimple>[2];
  const spy = withCacheMarks(Object.assign(Object.create(models), {
    streamSimple: (_model: unknown, _request: unknown, options: typeof given) => { given = options; return { result: async () => undefined }; },
  }) as typeof models);
  spy.streamSimple(model, request);
  const payload = { messages: [{ role: 'user', content: [{ type: 'text', text: `<chat>\n${'0+1|user: x\n'.repeat(12)}</chat>` }] }] };
  assert.ok(JSON.stringify(await given?.onPayload?.(payload, model)).includes('cache_control'));
  const own = { onPayload: (p: unknown) => p };
  spy.streamSimple(model, request, own);
  assert.equal(given, own);
});

test('a run past the refresh share of the window moves its steps into memory and goes on with the task and its last step', async () => {
  // A window of 150 tokens: a refresh once the run passes 180 characters (30%), each step here about 55.
  const agent = await open(file(), [read(0), read(1), read(2), read(3), read(4), read(5), fauxAssistantMessage('done')], undefined, { contextWindow: 150 });
  try {
    await agent.ask('read them all');
    const runs = agent.sent.map(request => request.filter(m => m.role !== 'system').map(m => `${m.role}: ${text(m.content)}`));
    const refreshed = runs.findIndex(run => run[0].includes('this turn grew long'));
    assert.ok(refreshed > 0, 'a request was refreshed');
    // The task, then only the last step; the steps before it are view lines, each logged once.
    assert.deepEqual(runs[refreshed].map(line => line.split(':')[0]), ['user', 'assistant', 'toolResult']);
    assert.match(runs[refreshed][0], /\|tool: date \{"id":0\}/);
    assert.ok(runs.every(run => run.length <= runs[refreshed - 1].length));
    assert.deepEqual(agent.memory.root.map(e => e.kind), ['user', ...Array(6).fill(['tool', 'echo']).flat(), 'talk']);
  } finally { await agent.close(); }
});

test('a refresh keeps the task of the run being answered, not an earlier run queued into the same context', async () => {
  const agent = await open(file(), [fauxAssistantMessage('A done'), read(0), read(1), read(2), read(3), read(4), read(5), fauxAssistantMessage('B done')], undefined, { contextWindow: 150 });
  try {
    const a = await agent.root.submit({ type: 'input', content: 'task A' }, context), b = await agent.root.submit({ type: 'input', content: 'task B' }, context);
    await a.wait(context); await b.wait(context); await agent.idle();
    const refreshed = agent.sent.map(request => request.filter(m => m.role !== 'system').map(m => text(m.content))).find(run => run[0].includes('this turn grew long'));
    // Run A is in the view now; task B is the one sent whole.
    assert.match(refreshed?.[0] ?? '', /\|talk: A done\n[^]*<\/chat>\n\ntask B\n\n\[OptChat: this turn grew long/);
  } finally { await agent.close(); }
});

test('a run queued behind a refreshed one is sent without it: the earlier run is in memory whole', async () => {
  const agent = await open(file(), [read(0), read(1), read(2), read(3), read(4), read(5), fauxAssistantMessage('A done'), fauxAssistantMessage('B done')], undefined, { contextWindow: 150 });
  try {
    const a = await agent.root.submit({ type: 'input', content: 'task A' }, context), b = await agent.root.submit({ type: 'input', content: 'task B' }, context);
    await a.wait(context); await b.wait(context); await agent.idle();
    const first = agent.sent[7].filter(m => m.role !== 'system').map(m => text(m.content));
    assert.equal(first.length, 1);
    assert.match(first[0], /\|talk: A done\n<\/chat>\n\ntask B$/);
    assert.deepEqual(agent.memory.root.map(e => e.kind), ['user', ...Array(6).fill(['tool', 'echo']).flat(), 'talk', 'user', 'talk']);
  } finally { await agent.close(); }
});

test('reopened mid-run after a refresh, the run is sent from where the log says', async () => {
  const path = file();
  // The sixth request, the one after the first refresh, answers only once aborted: the object is evicted while it waits. Reopened, it must
  // send the task and the two steps since the cut again, not cut once more.
  const evicted: FauxResponseStep = (_request, options) => new Promise((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new Error('Evicted'))));
  const before = await open(path, [read(0), read(1), read(2), read(3), read(4), evicted], undefined, { contextWindow: 150 });
  await before.root.submit({ type: 'input', content: 'read them all' }, context);
  while (before.sent.length < 6) await new Promise(resolve => setTimeout(resolve, 5));
  const cutOff = before.sent[5].filter(m => m.role !== 'system').map(m => text(m.content));
  await before.close();
  const after = await open(path, [fauxAssistantMessage('done')], undefined, { contextWindow: 150 });
  try {
    await after.idle();
    assert.ok(cutOff[0].includes('this turn grew long') && cutOff.length === 5);
    assert.deepEqual(after.sent[0].filter(m => m.role !== 'system').map(m => text(m.content)), cutOff);
    // Five steps before the eviction, each logged once although the refresh logged some of them before it.
    assert.deepEqual(after.memory.root.map(e => e.kind), ['user', ...Array(5).fill(['tool', 'echo']).flat(), 'talk']);
  } finally { await after.close(); }
});

// Imports: a new generation is built beside the live one by a Pi Durable task, and made live in one transaction.
const long = (s: string) => `${s} ${'detail '.repeat(80)}`;
const old = (n: number): ImportedEntry => ({ kind: n % 2 ? 'talk' : 'user', text: long(`old-${n}`), date: new Date(Date.UTC(2020, 0, 1, 0, 0, n)).toISOString(),
  receipt: `import:test:${n}`, origin: { source: 'test', conversation: 'old', message: `${n}`, title: 'Old chat' } });
const history = Array.from({ length: 6 }, (_, n) => old(n));
const words = (agent: { memory: { entries(): { text: string }[] } }) => agent.memory.entries().map(e => e.text.split(' ')[0]);
/** A compressor that records the source of each summary it makes. Once `hold(n)` is called, calls after the next n wait until
 * `release`, or until their signal aborts. */
function recording() {
  const made: string[] = [];
  let left = Infinity, released = () => {}, gate = Promise.resolve();
  const compress: Compressor = async ({ part, source }, signal) => {
    if (left-- <= 0) await Promise.race([gate, new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))]);
    made.push(source);
    return `line ${part.l}/${part.i}`;
  };
  return { made, compress,
    hold: (n = 0) => { left = n; gate = new Promise(resolve => { released = resolve; }); },
    release: () => { left = Infinity; released(); } };
}
const until = async (done: () => boolean | Promise<boolean>) => { while (!await done()) await new Promise(resolve => setImmediate(resolve)); };
const generations = (agent: { sql: DatabaseSync }) => agent.sql.prepare('SELECT DISTINCT g FROM optchat_log ORDER BY g').all().map(row => row.g);

test('a rebuild cut off by a restart resumes without summarizing anything twice, then switches to a log in date order', async () => {
  const path = file(), summaries = recording();
  const before = await open(path, [fauxAssistantMessage(long('answer'))], undefined, { importing: summaries.compress });
  await before.ask(long('question'));
  summaries.hold(3);
  assert.deepEqual(await before.importer.start(history, 'rebuild'), { generation: 1, mode: 'rebuild', total: 8, added: 6, skipped: 0 });
  await until(() => summaries.made.length === 3);
  await before.close();
  summaries.release();
  const after = await open(path, [], undefined, { importing: summaries.compress });
  await after.activated;
  // `memory` is the old generation's until the object restarts.
  await assert.rejects(after.importer.start([old(6)], 'append'), /restart/);
  await after.close();
  assert.equal(new Set(summaries.made).size, summaries.made.length);
  const restarted = await open(path, []);
  try {
    assert.deepEqual(words(restarted), ['old-0', 'old-1', 'old-2', 'old-3', 'old-4', 'old-5', 'question', 'answer']);
    assert.deepEqual(generations(restarted), [1]);
    assert.equal(await restarted.importer.pending(), undefined);
  } finally { await restarted.close(); }
});

test('an import saves its progress, so restarts over a long one don\'t park it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-durable-')), summaries = recording();
  dirs.push(dir);
  const snapshot = (n: number) => join(dir, `crash-${n}.sqlite`);
  let agent = await open(snapshot(0), [], undefined, { importing: summaries.compress });
  summaries.hold(60);
  await agent.importer.start(Array.from({ length: 400 }, (_, n) => old(n)), 'rebuild');
  try {
    // Pi Durable parks a task cut off 5 times without progress: crash 6 times, each after about 60 summaries.
    for (let crash = 1; crash <= 6; crash++) {
      const current = agent, made = summaries.made.length;
      const saved = async () => Number(JSON.stringify((await current.harness.inspect(context)).tasks).match(/"done":(\d+)/)?.[1] ?? 0);
      const before = await saved();
      // A parked task fails the test here, through `activated`.
      await Promise.race([until(() => summaries.made.length === made + 60), current.activated]);
      // Until the progress is saved, for a second at most.
      const deadline = Date.now() + 1000;
      await until(async () => await saved() > before || Date.now() > deadline);
      // A copy taken as the process dies: the task is still running in it.
      await until(() => { try { current.sql.exec(`VACUUM INTO '${snapshot(crash)}'`); return true; } catch { return false; } });
      await current.close();
      if (crash < 6) summaries.hold(60); else summaries.release();
      agent = await open(snapshot(crash), [], undefined, { importing: summaries.compress });
    }
    await agent.activated;
    assert.equal(agent.memory.root.length, 0);
  } finally { await agent.close(); }
});

test('a turn during an import is answered from the old memory, and is in the new one once after the switch', async () => {
  for (const [mode, expected] of [
    ['append', ['first', 'one', 'old-0', 'old-1', 'old-2', 'old-3', 'old-4', 'old-5', 'second', 'two', 'third', 'three']],
    ['rebuild', ['old-0', 'old-1', 'old-2', 'old-3', 'old-4', 'old-5', 'first', 'one', 'second', 'two', 'third', 'three']],
  ] as const) {
    const path = file(), summaries = recording();
    const before = await open(path, [fauxAssistantMessage('one'), fauxAssistantMessage('two')], undefined, { importing: summaries.compress });
    await before.ask('first');
    summaries.hold();
    await before.importer.start(history, mode);
    await before.ask('second');
    assert.deepEqual(words(before), ['first', 'one', 'second', 'two']);
    summaries.release();
    await before.activated;
    await before.close();
    const after = await open(path, [fauxAssistantMessage('three')]);
    try {
      // The new generation has the log as planned; the turn after the plan is logged again from Pi's transcript.
      await after.ask('third');
      assert.deepEqual(words(after), expected, mode);
    } finally { await after.close(); }
  }
});

test('a rebuild that puts an imported message without an origin after the chat logs no turn twice', async () => {
  const path = file();
  const before = await open(path, [fauxAssistantMessage('one'), fauxAssistantMessage('two')]);
  await before.ask('first');
  await before.ask('second');
  await before.importer.start([{ kind: 'talk', text: 'bare', date: new Date(Date.UTC(2020, 0, 1)).toISOString(), receipt: 'import:bare' }], 'rebuild');
  await before.activated;
  await before.close();
  const after = await open(path, [fauxAssistantMessage('three')]);
  try {
    await after.ask('third');
    assert.deepEqual(words(after), ['bare', 'first', 'one', 'second', 'two', 'third', 'three']);
  } finally { await after.close(); }
});

test('a rebuild that orders a turn before an earlier one, as a clock behind does, logs no turn twice', async () => {
  const path = file();
  const before = await open(path, [fauxAssistantMessage('one'), fauxAssistantMessage('two')]);
  await before.ask('first');
  await before.ask('second');
  // The second turn's clock was an hour behind.
  const behind = new Date(Date.parse(before.memory.root[0].date) - 3_600_000).toISOString();
  before.sql.prepare("UPDATE optchat_log SET meta = json_set(meta, '$.date', ?) WHERE i >= 2 AND part = 0").run(behind);
  await before.close();
  const between = await open(path, []);
  await between.importer.start(history, 'rebuild');
  await between.activated;
  await between.close();
  const after = await open(path, [fauxAssistantMessage('three')]);
  try {
    await after.ask('third');
    assert.deepEqual(words(after), ['old-0', 'old-1', 'old-2', 'old-3', 'old-4', 'old-5', 'second', 'two', 'first', 'one', 'third', 'three']);
  } finally { await after.close(); }
});

test('append keeps the summaries and view it has', async () => {
  const path = file(), summaries = recording();
  const before = await open(path, [fauxAssistantMessage(long('a-one')), fauxAssistantMessage(long('a-two'))], summaries.compress);
  await before.ask(long('q-one'));
  await before.ask(long('q-two'));
  const kept = summaries.made.slice(), view = before.sql.prepare('SELECT json FROM optchat_view WHERE g = 0').get()?.json;
  // Each kept message was long enough to be summarized.
  assert.ok(kept.length >= 4);
  await before.importer.start(history, 'append');
  await before.activated;
  const made = summaries.made.slice(kept.length);
  await before.close();
  // None of the kept summaries is made again, and the new memory starts from the saved view, whose cached prefix holds.
  assert.deepEqual(made.filter(source => kept.includes(source)), []);
  assert.deepEqual(before.loaded, [view]);
});

test('a node over a message the new generation didn\'t copy stays out of it', async () => {
  const agent = await open(file(), [fauxAssistantMessage(long('a-one')), fauxAssistantMessage(long('a-two'))]);
  try {
    await agent.ask(long('q-one'));
    await agent.ask(long('q-two'));
    // As if the plan was made before the last message and its summaries were saved.
    const entries = agent.memory.entries().slice(0, 3);
    const { generation } = await importTables(agent.db, agent.query).stage(0, 'append', [...entries, { ...old(0), i: 3 }], 3);
    const staged = await openMemory(new SqliteStore(agent.db, agent.query, { generation }), async () => 'line');
    assert.deepEqual([staged.root.length, [...staged.tree.values()].every(node => (node.i + 1) * 2 ** node.l <= 3)], [3, true]);
    await staged.close();
  } finally { await agent.close(); }
});

test('a discarded import leaves memory as it was; a second import or one after a failed save is refused', async () => {
  const path = file(), summaries = recording();
  const before = await open(path, [fauxAssistantMessage('one')], undefined, { importing: summaries.compress });
  await before.ask('first');
  summaries.hold();
  // A bad entry is refused before anything is saved, so it can't leave a pending import that blocks the next.
  const bogus: ImportedEntry = JSON.parse(JSON.stringify({ ...old(6), kind: 'bogus' }));
  await assert.rejects(before.importer.start([bogus], 'append'), /invalid/);
  assert.equal(await before.importer.pending(), undefined);
  await before.importer.start(history, 'rebuild');
  assert.equal((await before.importer.pending())?.task?.kind, 'running');
  await assert.rejects(before.importer.start([old(6)], 'append'), /pending/);
  await before.importer.discard();
  assert.equal(await before.importer.pending(), undefined);
  summaries.release();
  await before.close();
  const after = await open(path, []);
  try {
    assert.deepEqual(words(after), ['first', 'one']);
    assert.deepEqual(generations(after), [0]);
    after.memory.store.append = async () => { throw new Error('SQLITE_FULL'); };
    after.memory.append('user', 'lost');
    await until(() => after.memory.saveError !== undefined);
    await assert.rejects(after.importer.start(history, 'append'), /SQLITE_FULL/);
  } finally { await after.close(); }
});
