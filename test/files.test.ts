import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listProfiles, memoryDirectory, profileOwner, profilePath, readMemory } from '../src/files.ts';
import { Memory } from '../src/memory.ts';
import { localDay } from '../src/store.ts';
import { lockProfile, ProfileBusyError } from '../src/profiles.ts';
import { removeDir } from './support.ts';

const temp = () => mkdtempSync(join(tmpdir(), 'optchat-files-'));
/** Every file and directory under `dir`, with each file's bytes and identity: a file replaced by the same bytes still differs. */
const snapshot = (dir: string) => readdirSync(dir, { recursive: true, encoding: 'utf8' }).sort().map(path => {
  const file = join(dir, path), { ino, mtimeMs } = statSync(file);
  return [path, ino, mtimeMs, statSync(file).isDirectory() ? 'dir' : readFileSync(file).toString('base64')];
});

test('reading a memory writes nothing, while its owner is halfway through writing a line', async () => {
  const home = temp();
  try {
    const dir = join(home, 'profiles', 'work');
    mkdirSync(dir, { recursive: true });
    const owner = new Memory(dir, async ({ source }) => `summary of ${source.length} characters`, () => {}, 2000);
    for (let i = 0; i < 40; i++) owner.append(i % 2 ? 'talk' : 'user', `message ${i} ${'x'.repeat(i * 30)}`);
    await owner.settle(undefined, 'tree');
    await owner.store.putImage('0123456789abcdef', 'image/png', Uint8Array.of(1, 2, 3));
    await owner.close();
    // Two messages the owner hasn't summarized yet, and a third it is still writing.
    const log = join(dir, 'main', `${localDay()}.jsonl`), date = new Date().toISOString();
    appendFileSync(log, [40, 41].map(i => JSON.stringify({ i, kind: 'user', text: `late ${i}`, date }) + '\n').join('') + '{"i":42,"kind":"us');
    const before = snapshot(home);

    assert.deepEqual(listProfiles(home), ['work']);
    assert.equal(profilePath('work', home), dir);
    const memory = await readMemory(memoryDirectory(dir));
    assert.equal(memory.root.length, 42, 'the line still being written is left out');
    assert.equal(memory.text(41), 'late 41');
    assert.match(memory.zoom(0, 2), /^0\+1\|user: message 0/);
    assert.ok(memory.view.length > 0);
    assert.equal(memory.search('late 40').length, 1);
    assert.deepEqual((await memory.store.image('0123456789abcdef'))?.data, Buffer.of(1, 2, 3));
    await memory.close();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(snapshot(home), before, 'no file or directory changed, and no summary was built');
  } finally { removeDir(home); }
});

test('reading a profile that has no memory yet creates nothing', async () => {
  const dir = temp();
  try {
    const memory = await readMemory(dir);
    assert.equal(memory.root.length, 0);
    assert.deepEqual(readdirSync(dir), []);
  } finally { removeDir(dir); }
});

test('profileOwner tells who holds a profile without taking it', async () => {
  const dir = temp();
  try {
    assert.equal(await profileOwner(dir), undefined);
    const unlock = await lockProfile(dir, 'work · PID 1 · host · /cwd');
    assert.equal(await profileOwner(dir), 'work · PID 1 · host · /cwd');
    await assert.rejects(lockProfile(dir, 'another'), ProfileBusyError, 'the holder still has it');
    await unlock();
    assert.equal(await profileOwner(dir), undefined);
  } finally { removeDir(dir); }
});
