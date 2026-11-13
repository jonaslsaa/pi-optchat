import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProfile, fingerprint, listProfiles, loadConfig, memoryDirectory, profileOwner, profilePath, readImage, readMemory, readRuns, updateConfig } from '../src/files.ts';
import { Memory } from '../src/memory.ts';
import { localDay } from '../src/store.ts';
import { checkPatch, describeOwner, lockProfile, ProfileBusyError } from '../src/profiles.ts';
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
    const before = snapshot(home), print = fingerprint(dir);

    assert.deepEqual(listProfiles(home), ['work']);
    assert.equal(profilePath('work', home), dir);
    const memory = await readMemory(memoryDirectory(dir));
    assert.equal(memory.root.length, 42, 'the line still being written is left out');
    assert.equal(memory.text(41), 'late 41');
    assert.match(memory.zoom(0, 2), /^0\+1\|user: message 0/);
    assert.ok(memory.view.length > 0);
    assert.equal(memory.search('late 40').length, 1);
    assert.deepEqual(readImage(dir, '0123456789abcdef'), { mimeType: 'image/png', data: Buffer.of(1, 2, 3) });
    assert.equal(readImage(dir, 'fedcba9876543210'), undefined);
    await memory.close();
    assert.deepEqual(snapshot(home), before, 'no file or directory changed');
    assert.equal(fingerprint(dir), print);
    appendFileSync(log, 'er","text":"late 42","date":"2026-11-12T00:00:00.000Z"}\n');
    assert.notEqual(fingerprint(dir), print, 'a finished line changes it');
  } finally { removeDir(home); }
});

test('a summary the owner writes while memory is being read never covers a message the read missed', async () => {
  const dir = temp();
  try {
    const owner = new Memory(dir, async () => 'a summary', () => {}, 2000);
    for (const text of ['one', 'two']) owner.append('user', text);
    await owner.settle(undefined, 'tree'); await owner.close();
    // Just after the read gets the log, the owner appends message 2 and then its summary, as Memory writes them.
    const day = localDay(), date = new Date().toISOString(), read = fs.readFileSync;
    let wrote = false;
    mock.method(fs, 'readFileSync', (...args: Parameters<typeof read>) => {
      const result = read(...args);
      if (!wrote && String(args[0]).includes(join(dir, 'main'))) {
        wrote = true;
        appendFileSync(join(dir, 'main', `${day}.jsonl`), JSON.stringify({ i: 2, kind: 'user', text: 'three', date }) + '\n');
        appendFileSync(join(dir, 'tree', `${day}.jsonl`), JSON.stringify({ l: 0, i: 2, text: 'a summary', size: 9 }) + '\n');
      }
      return result;
    });
    syncBuiltinESMExports();
    try {
      const memory = await readMemory(dir);
      assert.ok(wrote);
      assert.equal(memory.root.length, 2, 'the read keeps what it saw: two messages, and no summary of the third');
    } finally { mock.restoreAll(); syncBuiltinESMExports(); }
  } finally { removeDir(dir); }
});

test('reading a profile that has no memory yet creates nothing', async () => {
  const dir = temp();
  try {
    const memory = await readMemory(dir);
    assert.equal(memory.root.length, 0);
    assert.deepEqual(readdirSync(dir), []);
  } finally { removeDir(dir); }
});

test('profileOwner tells who holds a profile without taking it, even from a cwd with " · " in it', async () => {
  const dir = temp();
  try {
    assert.equal(await profileOwner(dir), undefined);
    const owner = { profile: 'work', pid: 4242, host: 'mac.local', cwd: '/Users/me/a · b' };
    const unlock = await lockProfile(dir, describeOwner(owner));
    assert.deepEqual(await profileOwner(dir), owner);
    await assert.rejects(lockProfile(dir, 'another'), (error: unknown) => error instanceof ProfileBusyError && error.message === 'Profile already running: work · PID 4242 · mac.local · /Users/me/a · b', 'the holder still has it');
    await unlock();
    assert.equal(await profileOwner(dir), undefined);
  } finally { removeDir(dir); }
});

test('createProfile makes a profile under the home it is given, once', () => {
  const home = temp();
  try {
    createProfile('work', home);
    assert.deepEqual(listProfiles(home), ['work']);
    assert.throws(() => createProfile('work', home), /already exists/);
  } finally { removeDir(home); }
});

test('readRuns lists a profile\'s saved runs and leaves out one it can\'t read', () => {
  const home = temp();
  try {
    createProfile('work', home);
    const dir = profilePath('work', home);
    assert.deepEqual(readRuns(dir), [], 'no runs folder yet');
    const runs = join(dir, 'runs');
    mkdirSync(runs);
    const run = { id: 'a1', task: 'Check CI', cwd: '/tmp', model: 'anthropic/claude-sonnet-5-5', thinking: 'high', parentSession: 's',
      started: 1, depth: 1, state: 'completed', guidance: [], connected: true, window: { pid: 42 } };
    writeFileSync(join(runs, 'a1.optchat.json'), JSON.stringify(run));
    writeFileSync(join(runs, 'b2.optchat.json'), '{"id":"b2"');
    assert.deepEqual(readRuns(dir), [run]);
  } finally { removeDir(home); }
});

test('updateConfig with no Pi on the profile writes config.json under its lock, keeping keys this copy does not know, and refuses what the settings page would', async () => {
  const home = temp();
  try {
    createProfile('work', home);
    const dir = profilePath('work', home), file = join(dir, 'config.json');
    // A setting from a newer OptChat that this copy doesn't know.
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), laterSetting: 'kept' }));
    const subagent = { provider: 'p', model: 'm', thinking: 'low' } as const;
    const config = await updateConfig(dir, { maxAgents: 3, memorySearch: true, subagent });
    assert.deepEqual([config.maxAgents, config.memorySearch, config.subagent], [3, true, subagent]);
    assert.deepEqual(loadConfig(dir), config);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).laterSetting, 'kept');
    const before = readFileSync(file, 'utf8');
    await assert.rejects(updateConfig(dir, { maxAgents: 0 }), /Max active agents must be a whole number of 1 or more/);
    assert.equal(readFileSync(file, 'utf8'), before, 'a refused change writes nothing');
    for (const [patch, reason] of [[{ groupReports: 'yes' }, /true or false/], [{ nope: 1 }, /Unknown setting: nope/], [{ main: subagent }, /main model follows Pi/],
      [{ compactor: { provider: 'p', model: 'm', thinking: 'huge' } }, /compactor must be/], [[], /must be an object/]] as const)
      assert.throws(() => checkPatch(patch), reason);
    // Held by a Pi that takes no changes (pi -p serves no socket).
    const unlock = await lockProfile(dir, describeOwner({ profile: 'work', pid: 1, host: 'h', cwd: '/' }));
    try { await assert.rejects(updateConfig(dir, { maxAgents: 4 }), /pi -p/); }
    finally { await unlock(); }
    assert.equal(readFileSync(file, 'utf8'), before);
  } finally { removeDir(home); }
});
