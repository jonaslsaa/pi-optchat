import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync } from 'node:fs';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Memory, type Compressor, type SavedViews, type Summary, type Entry } from '../src/memory.ts';
import { FileStore, type Store } from '../src/store.ts';
import { removeDir } from './support.ts';

const temp = () => mkdtempSync(join(tmpdir(), 'optchat-views-'));
const tick = () => new Promise(resolve => setImmediate(resolve));
const date = '2026-10-12T12:00:00.000Z';
const entry = (i: number): Entry => ({ i, kind: 'user', text: 'original '.repeat(80), date, size: 720 });
const node = (l: number, i: number, size = 300): Summary => ({ l, i, text: 's'.repeat(size), size });
const leaves = (n: number): [number, number][] => Array.from({ length: n }, (_, i) => [0, i]);
const snapshot = (memory: Memory) => ({ chat: memory.render(), compaction: memory['compaction'].render(),
  chatSelection: memory['chat'].selection, compactionSelection: memory['compaction'].selection });
const state = (dir: string): SavedViews => JSON.parse(readFileSync(join(dir, 'view.json'), 'utf8'));
function seed(dir: string, count: number, nodes: Summary[], view?: SavedViews | [number, number][]) {
  const store = new FileStore(dir); store.load();
  for (let i = 0; i < count; i++) store.append(entry(i));
  for (const n of nodes) store.appendNode(n);
  if (view) store.saveView(JSON.stringify(view));
  return store;
}
const completeTree = (count: number, size: number) => {
  const nodes: Summary[] = [];
  for (let l = 0; 2 ** l <= count; l++) for (let i = 0; i < Math.floor(count / 2 ** l); i++) nodes.push(node(l, i, size));
  return nodes;
};

test('both saved selections restore byte for byte without forcing a new compaction batch', async () => {
  const dir = temp(), selection = { parts: leaves(8), batch: false };
  seed(dir, 8, completeTree(8, 100), { version: 1, count: 8, chat: selection, compaction: selection });
  let memory = new Memory(dir, async () => 'unused', () => {}, 4000);
  try {
    assert.deepEqual(memory['compaction'].selection, selection);
    assert.ok(memory['compaction'].size > 500 && memory['compaction'].size < 1000);
    const before = snapshot(memory);
    await memory.close(); memory = new Memory(dir, async () => 'unused', () => {}, 4000);
    assert.deepEqual(snapshot(memory), before);
  } finally { await memory.close(); removeDir(dir); }
});

for (const partial of [false, true]) test(`restart retains a ${partial ? 'partial' : 'no-parent'} batch below its upper bound and continues on node completion`, async () => {
  const dir = temp(), copy = temp();
  const nodes = Array.from({ length: 4 }, (_, i) => node(0, i));
  if (partial) nodes.push(node(1, 0));
  seed(dir, 4, nodes, leaves(4));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const compress: Compressor = async input => { await gate; return 's'.repeat(input.part.l === 1 ? 300 : 80); };
  const live = new Memory(dir, compress, () => {}, 1000);
  let restarted: Memory | undefined;
  try {
    await tick();
    assert.equal(state(dir).chat.batch, true, 'even a batch that cannot merge must be saved');
    assert.equal(state(dir).compaction.batch, true);
    if (partial) assert.ok(live.size < 1000 && live.size > 500);
    cpSync(dir, copy, { recursive: true });
    restarted = new Memory(copy, compress, () => {}, 1000);
    assert.deepEqual(snapshot(restarted), snapshot(live));
    release();
    await Promise.all([live.settle(AbortSignal.timeout(5000), 'tree'), restarted.settle(AbortSignal.timeout(5000), 'tree')]);
    assert.deepEqual(snapshot(restarted), snapshot(live));
    assert.ok(live.size <= 500);
    assert.equal(state(dir).chat.batch, false);
    assert.equal(state(dir).compaction.batch, false);
    live.append('user', 'next'); restarted.append('user', 'next');
    await Promise.all([live.settle(AbortSignal.timeout(5000), 'tree'), restarted.settle(AbortSignal.timeout(5000), 'tree')]);
    assert.deepEqual(snapshot(restarted), snapshot(live));
    const before = snapshot(restarted); await restarted.close();
    restarted = new Memory(copy, compress, () => {}, 1000);
    assert.deepEqual(snapshot(restarted), before, 'completed batches stay completed');
  } finally { release(); await live.close(); await restarted?.close(); removeDir(dir); removeDir(copy); }
});

test('a compaction-only merge and batch transition save independently of the main view', async () => {
  const dir = temp(), nodes = Array.from({ length: 4 }, (_, i) => node(0, i));
  const selection = { parts: leaves(4), batch: false };
  seed(dir, 4, nodes, { version: 1, count: 4, chat: selection, compaction: selection });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const memory = new Memory(dir, async () => { await gate; return 'small'; }, () => {}, 4000);
  try {
    assert.deepEqual(state(dir).chat, selection);
    assert.equal(state(dir).compaction.batch, true);
    release(); await memory.settle(AbortSignal.timeout(5000), 'tree');
    const saved = state(dir);
    assert.deepEqual(saved.chat, selection);
    assert.equal(saved.compaction.batch, false);
    assert.notDeepEqual(saved.compaction.parts, selection.parts);
    await memory.close();
    const restored = new Memory(dir, async () => 'unused', () => {}, 4000);
    try { assert.deepEqual(snapshot(restored), snapshot(memory)); } finally { await restored.close(); }
  } finally { release(); await memory.close(); removeDir(dir); }
});

test('main batches force a below-threshold compaction view toward its lower target', async () => {
  const dir = temp(), nodes = completeTree(8, 300);
  nodes.push(node(1, 0, 60), node(1, 1, 60), node(1, 2, 60), node(1, 3, 60), node(2, 0, 30), node(2, 1, 30), node(3, 0, 10));
  seed(dir, 8, nodes, { version: 1, count: 8, chat: { parts: leaves(8), batch: false },
    compaction: { parts: [[1, 0], [1, 1], [1, 2], [1, 3]], batch: false } });
  const memory = new Memory(dir, async () => 'unused', () => {}, 2000);
  try {
    assert.ok(memory.size <= 1000);
    assert.ok(memory['compaction'].size <= 250, 'main batch forces a compaction view initially between 250 and 500 bytes');
  } finally { await memory.close(); removeDir(dir); }
});

test('legacy pair arrays migrate once without changing originals or immutable summaries', async () => {
  const dir = temp(), store = seed(dir, 8, completeTree(8, 100), [[2, 0], [1, 2], [0, 6], [0, 7]]);
  const before = store.load();
  const memory = new Memory(dir, async () => { throw new Error('must reuse nodes'); }, () => {}, 4000);
  try {
    assert.deepEqual(state(dir).chat.parts, [[2, 0], [1, 2], [0, 6], [0, 7]]);
    assert.equal(state(dir).version, 1);
    await memory.settle(AbortSignal.timeout(5000), 'tree');
    assert.deepEqual(store.load().entries, before.entries);
    assert.deepEqual(store.load().tree, before.tree);
  } finally { await memory.close(); removeDir(dir); }
});

test('a failed atomic view replacement retains its previous checkpoint and retries at the next message', async () => {
  const dir = temp(), warnings: string[] = [];
  const selection = { parts: leaves(4), batch: false };
  seed(dir, 4, completeTree(4, 300), { version: 1, count: 4, chat: selection, compaction: selection });
  const previous = readFileSync(join(dir, 'view.json'), 'utf8');
  let fail = true;
  const rename = fs.renameSync;
  const patched = mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
    if (fail && to === join(dir, 'view.json')) throw new Error('interrupted replacement');
    return rename(from, to);
  });
  syncBuiltinESMExports();
  const store = new FileStore(dir), memory = new Memory({ directory: dir, store, saved: store.load() }, async () => 'small', s => warnings.push(s), 1000);
  try {
    assert.equal(readFileSync(join(dir, 'view.json'), 'utf8'), previous);
    assert.match(warnings.join('\n'), /interrupted replacement/);
    fail = false;
    memory.append('user', 'next'); await memory.settle(AbortSignal.timeout(5000), 'tree');
    const saved = state(dir);
    assert.equal(saved.count, 5);
    assert.deepEqual(saved.chat, memory['chat'].selection);
    assert.deepEqual(saved.compaction, memory['compaction'].selection);
  } finally { patched.mock.restore(); syncBuiltinESMExports(); await memory.close(); removeDir(dir); }
});

test('async checkpoints freeze a coherent log boundary before later appends and replay their tail consistently', async () => {
  const dir = temp(), copy = temp(), base = new FileStore(dir), saved = base.load(), checkpoints: SavedViews[] = [];
  const store: Store = {
    load: () => base.load(), append: e => base.append(e), appendNode: n => base.appendNode(n), savePending: entries => base.savePending(entries),
    saveView: async view => {
      await tick(); const snapshot: SavedViews = JSON.parse(view);
      assert.ok(snapshot.count <= base.load().entries.length, 'no checkpoint can precede its log');
      for (const selection of [snapshot.chat, snapshot.compaction]) assert.equal(selection.parts.reduce((sum, [l]) => sum + 2 ** l, 0), snapshot.count);
      checkpoints.push(snapshot); base.saveView(view);
    },
    putImage: (...args) => base.putImage(...args), image: name => base.image(name),
  };
  const memory = new Memory({ directory: dir, store, saved }, async () => 's'.repeat(100), () => {}, 1000);
  let restored: Memory | undefined;
  try {
    for (let i = 0; i < 24; i++) memory.append('user', `original ${i} ${'x'.repeat(700)}`);
    await memory.settle(AbortSignal.timeout(5000), 'tree'); await memory.durable();
    assert.equal(checkpoints[0].count, 0, 'the queued initial checkpoint must not pick up later appends');
    cpSync(dir, copy, { recursive: true });
    restored = new Memory(copy, async () => 's'.repeat(100), () => {}, 1000);
    assert.deepEqual(snapshot(restored), snapshot(memory));
  } finally { await memory.close(); await restored?.close(); removeDir(dir); removeDir(copy); }
});
