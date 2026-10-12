import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Memory, Sawtooth, type Part, type Summary, type Entry } from '../src/memory.ts';
import type { Store } from '../src/store.ts';

const id = ({ l, i }: Part) => `${l}:${i}`;
const byteLength = (text: string) => Buffer.byteLength(text, 'utf8');
// Independent of the production renderer and its incremental size calculation.
const serialized = (parts: readonly Part[], node: (part: Part) => Summary | undefined) => '<chat>\n'
  + parts.map(p => `${p.i * 2 ** p.l}+${2 ** p.l}|${(node(p)?.text ?? '(not summarized yet: zoom it)').replace(/[\r\n]+/g, ' ')}`).join('\n')
  + '\n</chat>';
const summary = (part: Part, text: string): Summary => ({ ...part, text, size: byteLength(text.replace(/[\r\n]+/g, ' ')) });

test('rendered accounting includes framing, labels, separators, Unicode, placeholders and built replacements', () => {
  const nodes = new Map<string, Summary>(), get = (p: Part) => nodes.get(id(p));
  const view = new Sawtooth(128_000, 64_000, get);
  const check = () => {
    const text = serialized(view.parts, get);
    assert.equal(view.render(), text);
    assert.equal(view.size, byteLength(text));
  };
  check();
  for (const i of [0, 9, 10, 99999, 100000, 2 ** 40]) { view.push({ l: 0, i }); check(); }
  for (const [j, p] of view.parts.entries()) {
    nodes.set(id(p), summary(p, ['x', '字😀\r\n\nsecond line', 'x'.repeat(512)][j % 3]));
    view.built(p.i); check();
  }
  const part = { l: 20, i: 2 ** 20 };
  nodes.set(id(part), summary(part, 'large range'));
  view.push(part); check();
});

test('both budget scales trigger only above the rendered upper bound and merge to the lower bound', () => {
  for (const high of [128_000, 32_000]) {
    const nodes = new Map<string, Summary>(), get = (p: Part) => nodes.get(id(p));
    const view = new Sawtooth(high, high / 2, get);
    for (let i = 0; i < 256; i++) {
      const p = { l: 0, i };
      nodes.set(id(p), summary(p, 'x'.repeat(500))); view.push(p);
      for (let l = 1; 2 ** l <= i + 1 && (i + 1) % 2 ** l === 0; l++) {
        const parent = { l, i: (i + 1) / 2 ** l - 1 };
        nodes.set(id(parent), summary(parent, 'merged'));
      }
      const before = byteLength(serialized(view.parts, get));
      const changed = view.fit(i + 1);
      assert.equal(changed, before > high);
      assert.equal(view.size, byteLength(serialized(view.parts, get)));
      if (changed) assert.ok(view.size <= high / 2);
    }
    // The exact boundary does not start a batch, even with a parent available.
    const exact = new Sawtooth(high, high / 2, get);
    nodes.set('0:0', summary({ l: 0, i: 0 }, 'x'.repeat(high - 25)));
    nodes.set('0:1', summary({ l: 0, i: 1 }, 'x'));
    exact.push({ l: 0, i: 0 }); exact.push({ l: 0, i: 1 });
    assert.equal(exact.size, high);
    assert.equal(exact.fit(2), false);
    exact.push({ l: 0, i: 2 });
    assert.equal(exact.fit(3), true);
    assert.equal(exact.size, byteLength(serialized(exact.parts, get)));
    assert.ok(exact.size <= high / 2);
  }
});

test('a batch counts every line while waiting for parents, then accounts for changed range labels', () => {
  const nodes = new Map<string, Summary>(), get = (p: Part) => nodes.get(id(p));
  const view = new Sawtooth(100, 50, get);
  for (let i = 0; i < 16; i++) { const p = { l: 0, i }; nodes.set(id(p), summary(p, 'x')); view.push(p); }
  assert.equal(view.fit(16), false);
  assert.ok(view.size > 100);
  for (let l = 1; l <= 4; l++) {
    for (let i = 0; i < 16 / 2 ** l; i++) { const p = { l, i }; nodes.set(id(p), summary(p, 'x')); }
    view.fit(16);
    assert.equal(view.size, byteLength(serialized(view.parts, get)));
  }
  assert.ok(view.size <= 50);
  assert.ok(view.parts.some(p => p.l >= 2));
});

test('16,000 short leaves cannot evade either maintained view budget with all parents built', async () => {
  const entries: Entry[] = Array.from({ length: 16_000 }, (_, i) => ({ i, kind: 'user', text: 'x', size: 7, date: '2026-10-12' }));
  const tree: Summary[] = [];
  for (let l = 0; 2 ** l <= entries.length; l++) {
    for (let i = 0; i < Math.floor(entries.length / 2 ** l); i++) tree.push(summary({ l, i }, 'user: x'));
  }
  const saved = { entries, tree, view: JSON.stringify(entries.map(e => [0, e.i])) };
  const store: Store = { load: () => saved, append: () => undefined, appendNode: () => undefined,
    saveView: () => undefined, savePending: () => undefined, putImage: () => undefined, image: () => undefined };
  const memory = new Memory({ directory: '/unused', saved, store }, async () => { throw new Error('all nodes already built'); });
  try {
    for (const [view, high] of [[memory['chat'], 128_000], [memory['compaction'], 32_000]] as const) {
      const actual = serialized(view.parts, p => memory.node(p));
      assert.equal(view.size, byteLength(actual));
      assert.equal(view.render(), actual);
      assert.ok(view.size <= high / 2, `${view.size} exceeds the completed batch target ${high / 2}`);
    }
    // A compactor sends only the portion before its leaf, not its entire maintained view.
    const prefix = memory['compactionView']({ l: 0, i: 8000 });
    const selection = memory['compaction'].parts.filter(p => (p.i + 1) * 2 ** p.l <= 8000);
    assert.equal(prefix, serialized(selection, p => memory.node(p)));
    assert.ok(byteLength(prefix) < memory['compaction'].size);
    assert.equal(memory.pending, 0);
  } finally { await memory.close(); }
});
