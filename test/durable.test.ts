import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRegistry, Harness } from '@earendil-works/pi-durable';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { NodeSqliteDatabase } from '@earendil-works/chord/sqlite/node';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type FauxResponseStep } from '@earendil-works/pi-ai/providers/faux';
import { openMemory, type Compressor, type Mime } from '../src/core/index.ts';
import { MAX_IMAGE_BYTES, optchat, SqliteStore, withCacheMarks, type SqliteStoreOptions } from '../src/durable/index.ts';
import { imageRef } from '../src/images.ts';
import { removeDir } from './support.ts';

type Sent = { role: string; content: unknown }[];
const text = (content: unknown) => typeof content === 'string' ? content
  : (content as { type: string; text?: string }[]).map(block => block.text ?? `[${block.type}]`).join('');

/** One OptChat agent on Pi Durable, over one SQLite database as in a Durable Object: Pi's tables `pi_*`, memory's `optchat_*`. */
async function open(file: string, replies: FauxResponseStep[], compress: Compressor = async ({ part }) => `line ${part.l}/${part.i}`,
  { contextWindow, images }: { contextWindow?: number } & SqliteStoreOptions = {}) {
  const sync = new DatabaseSync(file), db = new NodeSqliteDatabase(sync);
  const faux = fauxProvider(contextWindow ? { models: [{ id: 'small', contextWindow }] } : {}), models = createModels();
  models.setProvider(faux.provider);
  const sent: Sent[] = [];
  faux.setResponses(replies.map(reply => (request, ...rest) => {
    sent.push(request.messages.map(m => ({ role: m.role, content: 'content' in m ? m.content : undefined })));
    return typeof reply === 'function' ? reply(request, ...rest) : reply;
  }));
  const memory = await openMemory(new SqliteStore(db, (sql, ...params) => sync.prepare(sql).iterate(...params), { images }), compress);
  const memoryExtension = optchat({ memory });
  const registry = createRegistry();
  registry.install(memoryExtension.extension);
  const harness = await Harness.open(await SqliteStorage.open(db, { prefix: 'pi_' }),
    { models: withCacheMarks(models), registry, settings: { compaction: { enabled: false }, afterFailedRun: 'continue' } }, context);
  const root = await harness.root(context, { agent: { model: { provider: faux.provider.id, modelId: faux.getModel().id } } });
  memoryExtension.attach(harness, context);
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
  return { memory, root, sent, ask, idle, close, keptInSqlite };
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

const photo = (size: number) => ({ type: 'image' as const, mimeType: 'image/jpeg', data: Buffer.alloc(size, 7).toString('base64') });
/** Asks with a photo, then has the model zoom into that message; returns what the model got back from the zoom. */
async function zoomIntoPhoto(agent: Awaited<ReturnType<typeof open>>, image: ReturnType<typeof photo>) {
  await (await agent.root.submit({ type: 'input', content: [{ type: 'text', text: 'look' }, image] }, context)).wait(context);
  await agent.idle();
  await agent.ask('show it again');
  const result = agent.sent.at(-1)?.find(m => m.role === 'toolResult');
  return Array.isArray(result?.content) ? result.content.filter(block => block.type === 'image') : [];
}
const zoomThenAnswer = () => [fauxAssistantMessage('nice'), fauxAssistantMessage(fauxToolCall('zoom', { id: 0 }), { stopReason: 'toolUse' }), fauxAssistantMessage('here')];

test('an image is named as in Pi, kept, named in the previous exchange, and zoom returns it', async () => {
  const agent = await open(file(), zoomThenAnswer()), image = photo(1000);
  try {
    assert.deepEqual(await zoomIntoPhoto(agent, image), [image]);
    assert.equal(agent.memory.text(0), `look\n${imageRef(image)}`);
    assert.equal(agent.keptInSqlite(), 1);
    // The next request's previous exchange names the image instead of sending it again.
    assert.equal(text(agent.sent[1].find(m => m.role === 'user')?.content).split('</chat>\n\n')[1], `look\n${imageRef(image)}`);
  } finally { await agent.close(); }
});

test('an image too big for a SQLite row is named but not kept', async () => {
  const agent = await open(file(), zoomThenAnswer()), image = photo(MAX_IMAGE_BYTES + 1);
  try {
    assert.deepEqual(await zoomIntoPhoto(agent, image), []);
    assert.equal(agent.memory.text(0), `look\n${imageRef(image)}`);
    assert.equal(agent.keptInSqlite(), 0);
  } finally { await agent.close(); }
});

test('with an images store, images go there whatever their size, and zoom reads them from it', async () => {
  const kept = new Map<string, { mimeType: Mime; data: Uint8Array }>();
  const images: SqliteStoreOptions['images'] = { putImage: async (name, mimeType, data) => void kept.set(name, { mimeType, data }), image: name => kept.get(name) };
  const agent = await open(file(), zoomThenAnswer(), undefined, { images }), image = photo(MAX_IMAGE_BYTES + 1);
  try {
    assert.deepEqual(await zoomIntoPhoto(agent, image), [image]);
    assert.deepEqual([...kept.keys()], [imageRef(image).slice(7, -1)]);
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
