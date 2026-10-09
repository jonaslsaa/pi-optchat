import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Memory, type Entry, type Summary } from '../src/memory.ts';
import { FileStore, localDay, type Lease, type Saved, type Store } from '../src/store.ts';
import { holdProfile, HEARTBEAT_MS, isWindows, ProfileBusyError, profileSocket } from '../src/profiles.ts';

const entry = (i: number, text: string): Entry => ({ i, kind: 'user', text, size: 0, date: '2026-10-09T12:00:00.000Z' });
const node = (i: number, text: string): Summary => ({ l: 0, i, text, size: 0 });
const temp = () => mkdtempSync(join(tmpdir(), 'optchat-store-'));

/** What every store must do, so a new one can run the same checks against itself. */
function contract(name: string, open: (dir: string, warn: (s: string) => void) => Store) {
  test(`${name}: what is written loads back, in order, in a fresh store`, async () => {
    const dir = temp();
    try {
      const store = open(dir, () => {});
      await store.load();
      for (const [i, text] of ['one', 'two', 'three'].entries()) await store.append(entry(i, text));
      await store.appendNode(node(0, 'first summary'));
      await store.saveView('[[0,0]]'); await store.saveView('[[0,0],[0,1]]');
      const saved = await open(dir, () => {}).load();
      assert.deepEqual(saved.entries, ['one', 'two', 'three'].map((text, i) => entry(i, text)));
      assert.deepEqual(saved.tree, [node(0, 'first summary')]);
      assert.equal(saved.view, '[[0,0],[0,1]]');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test(`${name}: a store refuses to append after another one appended`, async () => {
    const dir = temp();
    try {
      const a = open(dir, () => {}), b = open(dir, () => {});
      await a.load(); await b.load();
      await a.append(entry(0, 'from a'));
      await assert.rejects(async () => b.append(entry(0, 'from b')), /nothing was written/);
      assert.deepEqual((await open(dir, () => {}).load()).entries, [entry(0, 'from a')]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
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
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
contract('FileStore', (dir, warn) => new FileStore(dir, warn));

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
  } finally { rmSync(dir, { recursive: true, force: true }); }
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
  } finally { mock.timers.reset(); rmSync(dir, { recursive: true, force: true }); }
});

test('a store that writes behind: appends return before it lands them, and once one fails nothing more is appended', async () => {
  const landed: string[] = [];
  let fail = false;
  const later = (text: string, failing = fail) => new Promise<void>((resolve, reject) => setTimeout(() => failing ? reject(new Error('offline')) : (landed.push(text), resolve()), 5));
  const store: Store = {
    load: async (): Promise<Saved> => ({ entries: [], tree: [] }),
    append: e => later(e.text), appendNode: n => later(`node ${n.i}`), saveView: () => later('view'),
    putImage: () => later('image'), image: async () => undefined,
  };
  const warnings: string[] = [];
  const memory = new Memory({ directory: temp(), store, saved: await store.load() }, async () => 'unused', text => warnings.push(text));
  memory.append('user', 'hello');
  assert.equal(landed.length, 0, 'append returns before the write lands');
  fail = true; memory.append('user', 'lost');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(landed.includes('hello'));
  assert.match(warnings.join('\n'), /Memory could not be saved: offline/);
  assert.throws(() => memory.append('user', 'more'), /Memory could not be saved: offline/);
  fail = false; await memory.close();
});
