import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Memory, CAP, PAGE } from '../src/memory.ts';

test('zoom pages a long message without splitting characters, and leaves short ones whole', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-large-'));
  const memory = new Memory(dir, async () => 'summary', () => {});
  try {
    memory.append('user', 'short');
    const long = 'a'.repeat(PAGE - 1) + '😀' + 'b'.repeat(40_000);
    memory.append('user', long);
    assert.equal(memory.zoom(0, 1), '0+0|user: short');
    let text = '', offset: number | undefined;
    for (let pages = 0; pages < 3; pages++) {
      const page = memory.zoom(1, 1, offset);
      assert.ok(page.length <= CAP);
      const [, body, from, to] = /^1\+0\|user: ([\s\S]*)\n\[showing characters (\d+)-(\d+) of 65001/.exec(page)!;
      assert.equal(Number(from), text.length);
      text += body; offset = Number(to);
    }
    assert.equal(text, long);
    assert.match(memory.zoom(1, 1, PAGE), /^1\+0\|user: 😀b/);
    assert.match(memory.zoom(1, 1, 10, 5), /^1\+0\|user: a{5}\n\[showing characters 10-15 of 65001; next page: offset 15\]$/);
    assert.match(memory.zoom(1, 1, PAGE, 1), /^1\+0\|user: \u{1F600}\n\[showing characters 24999-25001 of 65001; next page: offset 25001\]$/u);
    assert.throws(() => memory.zoom(1, 1, long.length), /offset must be 0 to 65000/);
    assert.throws(() => memory.zoom(0, 2, 0), /n = 1/);
  } finally { await memory.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('paging a message that fits in one zoom still works, but says so', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-large-'));
  const memory = new Memory(dir, async () => 'summary', () => {});
  try {
    memory.append('user', 'x'.repeat(3_120));
    assert.equal(memory.zoom(0, 1, 100, 10), `0+0|user: ${'x'.repeat(10)}\n[showing characters 100-110 of 3120; next page: offset 110]\n`
      + '[note: this message is only 3,120 characters and fits in one zoom; offset/limit are for messages over 25,000]');
  } finally { await memory.close(); rmSync(dir, { recursive: true, force: true }); }
});
