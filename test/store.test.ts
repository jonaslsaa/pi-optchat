import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isEntry, isSummary, openMemory, type Entry, type Part, type Summary } from '../src/core/memory.ts';
import { FileStore, localDay } from '../src/store.ts';
import type { Lease, Saved, Store } from '../src/core/store.ts';
import { holdProfile, HEARTBEAT_MS, isWindows, ProfileBusyError, profileSocket } from '../src/profiles.ts';
import { removeDir } from './support.ts';
import { DatabaseSync } from 'node:sqlite';
import { NodeSqliteDatabase } from '@earendil-works/chord/sqlite/node';
import { SqliteStore } from '../src/durable/index.ts';

const entry = (i: number, text: string): Entry => ({ i, kind: 'user', text, date: '2026-10-09T12:00:00.000Z' });
const node = (i: number, text: string): Summary => ({ l: 0, i, text, size: 0 });
const temp = () => mkdtempSync(join(tmpdir(), 'optchat-store-'));

/** A store's log and tree as memory reads them: metadata from `load` (a store may leave texts out there) and texts from `text`/`summary`. */
async function reload(store: Store) {
  const { entries, tree, view } = await store.load();
  const isPart = (value: unknown): value is Part => typeof value === 'object' && value !== null && 'l' in value && 'i' in value
    && typeof value.l === 'number' && typeof value.i === 'number';
  return { view, entries: entries.filter(e => typeof e === 'object' && e !== null).map((e, i) => ({ ...e, text: store.text(i) })),
    tree: tree.filter(isPart).map(n => ({ ...n, text: store.summary(n) })) };
}

/** What every store must do, so a new one can run the same checks against itself. */
function contract(name: string, open: (dir: string, warn: (s: string) => void) => Store) {
  test(`${name}: what is written loads back, in order, in a fresh store`, async () => {
    const dir = temp();
    try {
      const store = open(dir, () => {});
      await store.load();
      for (const [i, text] of ['one', 'two', 'three \ud83d'].entries()) await store.append(entry(i, text));
      await store.appendNode(node(0, 'first summary'));
      await store.saveView('[[0,0]]'); await store.saveView('[[0,0],[0,1]]');
      const saved = await reload(open(dir, () => {}));
      assert.deepEqual(saved.entries, ['one', 'two', 'three \ud83d'].map((text, i) => entry(i, text)), 'an unpaired surrogate comes back as it was');
      assert.deepEqual(saved.tree, [node(0, 'first summary')]);
      assert.equal(saved.view, '[[0,0],[0,1]]');
    } finally { removeDir(dir); }
  });
  test(`${name}: a store refuses to append after another one appended`, async () => {
    const dir = temp();
    try {
      const a = open(dir, () => {}), b = open(dir, () => {});
      await a.load(); await b.load();
      await a.append(entry(0, 'from a'));
      await assert.rejects(async () => b.append(entry(0, 'from b')), /nothing was written/);
      assert.deepEqual((await reload(open(dir, () => {}))).entries, [entry(0, 'from a')]);
    } finally { removeDir(dir); }
  });
  test(`${name}: images come back as they were put, and an unknown one is missing`, async () => {
    const dir = temp();
    try {
      const store = open(dir, () => {}), data = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
      await store.load();
      await store.putImage('0123456789abcdef', 'image/png', data);
      const kept = await open(dir, () => {}).image('0123456789abcdef');
      assert.equal(kept?.mimeType, 'image/png');
      assert.deepEqual(Uint8Array.from(kept?.data ?? []), data);
      assert.equal(await store.image('fedcba9876543210'), undefined);
    } finally { removeDir(dir); }
  });
}
contract('FileStore', (dir, warn) => new FileStore(dir, warn));
// As in a Durable Object, every store on one profile shares its database: here one in-memory database per folder, which also
// leaves no open file for Windows to refuse to delete.
const databases = new Map<string, DatabaseSync>();
const sqlite = (dir: string) => {
  let db = databases.get(dir);
  if (!db) databases.set(dir, db = new DatabaseSync(':memory:'));
  const sync = db;
  return new SqliteStore(new NodeSqliteDatabase(sync), (sql, ...params) => sync.prepare(sql).iterate(...params));
};
contract('SqliteStore', sqlite);

test('SqliteStore: a message over the 2 MB row limit is saved in parts and loads back whole', async () => {
  const dir = temp();
  try {
    // Over 3 MB of UTF-8, with an emoji whose surrogate pair straddles where a part would end (3 × 512Ki units, less the JSON's quote).
    const text = `${'ø€'.repeat(700_000)}${'x'.repeat(3 * 524_288 - 1 - 1 - 1_400_000)}😀 end`;
    await sqlite(dir).load();
    await sqlite(dir).append(entry(0, text));
    assert.deepEqual((await reload(sqlite(dir))).entries, [entry(0, text)]);
  } finally { removeDir(dir); }
});

test('FileStore: a line torn by a crash is skipped with a warning, and the next append starts on a fresh line', () => {
  const dir = temp();
  try {
    new FileStore(dir).load();
    const first = new FileStore(dir); first.load(); first.append(entry(0, 'kept'));
    appendFileSync(join(dir, 'main', `${localDay()}.jsonl`), '{"i":1,"kind":"us');
    const warnings: string[] = [], reopened = new FileStore(dir, text => warnings.push(text));
    assert.deepEqual(reopened.load().entries, [entry(0, 'kept')]);
    assert.match(warnings.join('\n'), /Skipped damaged JSON at .*:2/);
    reopened.append(entry(1, 'after the crash'));
    assert.deepEqual(new FileStore(dir, () => {}).load().entries, [entry(0, 'kept'), entry(1, 'after the crash')]);
  } finally { removeDir(dir); }
});

test('a store with a lease holds the profile instead of the local lock, renews it, and frees it on release', async () => {
  // Two machines sharing one lease table.
  let holder: string | undefined, beats = 0;
  const machine = (): { lock: Lease } => ({ lock: {
    async lease(_profile, who) { if (holder !== undefined) return holder; holder = who; return undefined; },
    async heartbeat() { beats++; },
    async release() { holder = undefined; },
  } });
  const dir = temp();
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    const release = await holdProfile(machine(), dir, 'work', 'laptop', () => {});
    if (!isWindows) assert.equal(existsSync(profileSocket(dir)), false, 'the machine-local lock is not taken');
    await assert.rejects(holdProfile(machine(), dir, 'work', 'desktop', () => {}), error => error instanceof ProfileBusyError && error.owner === 'laptop');
    mock.timers.tick(HEARTBEAT_MS * 3);
    assert.equal(beats, 3);
    await release();
    mock.timers.tick(HEARTBEAT_MS * 3);
    assert.equal(beats, 3, 'no renewals after release');
    await (await holdProfile(machine(), dir, 'work', 'desktop', () => {}))();
  } finally { mock.timers.reset(); removeDir(dir); }
});

/** A store that writes behind, each write landing sooner than the one before it, unless it was started while `fail` was set. */
function behind() {
  const landed: string[] = [], texts: string[] = [], summaries = new Map<string, string>();
  let fail = false, delay = 20;
  const later = (text: string) => {
    const failing = fail, ms = Math.max(1, delay -= 3);
    return new Promise<void>((resolve, reject) => setTimeout(() => failing ? reject(new Error('offline')) : (landed.push(text), resolve()), ms));
  };
  const store: Store = {
    load: async (): Promise<Saved> => ({ entries: [], tree: [] }),
    // A write-behind store can read a text only once its write has landed.
    append: e => later(e.text).then(() => { texts[e.i] = e.text; }), appendNode: n => later(`node ${n.i}`).then(() => { summaries.set(`${n.l}:${n.i}`, n.text); }),
    text: i => texts[i], summary: p => summaries.get(`${p.l}:${p.i}`)!, saveView: () => later('view'),
    putImage: () => later('image'), image: async () => undefined,
  };
  return { store, landed, failing: (on: boolean) => { fail = on; } };
}

test('a store that writes behind gets its writes one at a time, in the order Memory made them', async () => {
  const { store, landed } = behind();
  const memory = await openMemory(store, async () => 'unused', { warn: () => {} });
  for (const text of ['one', 'two', 'three']) memory.append('user', text);
  assert.equal(landed.length, 0, 'appends return before their writes land');
  assert.equal(memory.text(2), 'three', 'a message reads back before its write lands');
  await memory.settle(undefined, 'tree');
  assert.equal(memory.zoom(0, 2), '0+1|user: one\n1+1|user: two');
  await memory.close();
  assert.deepEqual(landed.filter(text => !text.startsWith('node') && text !== 'view'), ['one', 'two', 'three']);
  assert.ok(landed.indexOf('node 0') > landed.indexOf('one'), 'a node lands after its message');
});

test('a store that loads no texts gives the same memory as one that does, keeping none in RAM', async () => {
  const dir = temp();
  try {
    const writer = await openMemory(new FileStore(dir), async ({ source }) => `summary of ${source.length} characters`, { warn: () => {}, budget: 2000 });
    for (let i = 0; i < 40; i++) writer.append(i % 2 ? 'talk' : 'user', `message ${i} Blåbær ${'x'.repeat(i * 30)}`);
    await writer.settle(undefined, 'tree'); await writer.close();
    // Only metadata and the sizes Memory measured when it wrote the nodes: what a SQLite store would load.
    class Lazy extends FileStore {
      override load(): Saved {
        const { entries, tree, view } = super.load();
        return { entries: entries.filter(isEntry).map(({ text, ...meta }) => meta), tree: tree.filter(isSummary).map(({ text, ...node }) => node), view };
      }
    }
    const [a, b] = await Promise.all([openMemory(new FileStore(dir), async () => 'unused'), openMemory(new Lazy(dir), async () => 'unused')]);
    try {
      assert.equal(b.render(), a.render());
      assert.ok(b.root.every(m => !('text' in m)) && [...b.tree.values()].every(n => !('text' in n)));
      for (let id = 0; id < 40; id += 8) assert.equal(b.zoom(id, 8), a.zoom(id, 8));
      assert.deepEqual(b.search('BLÅBÆR', 30), a.search('BLÅBÆR', 30));
    } finally { await a.close(); await b.close(); }
  } finally { removeDir(dir); }
});

test('once a write-behind append fails, nothing more is written, summary nodes included, even if the store recovers', async () => {
  const { store, landed, failing } = behind(), warnings: string[] = [];
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const memory = await openMemory(store, async () => { await gate; return 'summary'; }, { warn: text => warnings.push(text) });
  const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  await wait(30); landed.length = 0;
  // Long enough to need the compactor, so its node is written only after the failed append has settled and the queue is empty.
  assert.equal(memory.saveError, undefined);
  failing(true); memory.append('user', 'lost '.repeat(200)); memory.append('user', 'queued behind it');
  await wait(60);
  assert.equal(memory.saveError, 'offline');
  assert.match(warnings.join('\n'), /Memory could not be saved: offline/);
  failing(false); release();
  await wait(60);
  assert.deepEqual(landed, [], 'no message, node or view is written after the failed append');
  assert.throws(() => memory.append('user', 'more'), /Memory could not be saved: offline/);
  await memory.close();
  assert.equal(memory.saveError, 'offline', 'close resolves, and the failure stays readable after it');
});
