import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProfile, dataHome, deleteProfile, holdProfile, isWindows, lastProfile, listProfiles, lockProfile, profilePath, ProfileBusyError, rememberProfile, type TakeLock } from '../src/profiles.ts';
import { removeDir } from './support.ts';

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'oc-delete-')), previous = process.env.OPTCHAT_HOME;
  process.env.OPTCHAT_HOME = dir;
  return () => {
    if (previous === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = previous;
    removeDir(dir);
  };
}

test('deleting a profile removes its folder and the last-profile pointer that named it', async () => {
  const cleanup = sandbox();
  try {
    createProfile('work'); createProfile('home');
    rememberProfile('work');
    assert.equal(lastProfile(), 'work');
    assert.equal(await deleteProfile('work'), profilePath('work'));
    assert.equal(existsSync(profilePath('work')), false);
    assert.deepEqual(listProfiles(), ['home']);
    assert.equal(lastProfile(), undefined);
    // Recreated under the same name, it is not the last profile on the strength of the old pointer.
    createProfile('work');
    assert.equal(lastProfile(), undefined, 'the stale pointer is gone even if the profile name is reused');
  } finally { cleanup(); }
});

test('deleting one profile keeps the last-profile pointer that names another', async () => {
  const cleanup = sandbox();
  try {
    createProfile('work'); createProfile('home');
    rememberProfile('home');
    await deleteProfile('work');
    assert.equal(lastProfile(), 'home');
  } finally { cleanup(); }
});

test('a profile another Pi is holding is refused and keeps every file', async () => {
  const cleanup = sandbox();
  try {
    createProfile('busy');
    writeFileSync(join(profilePath('busy'), 'main.jsonl'), 'my memory');
    const unlock = await lockProfile(profilePath('busy'), 'busy · PID 1234 · this machine');
    try {
      await assert.rejects(deleteProfile('busy'), error => error instanceof ProfileBusyError);
    } finally { await unlock(); }
    assert.equal(readFileSync(join(profilePath('busy'), 'main.jsonl'), 'utf8'), 'my memory');
    // The refusal is about the holder, not the profile: once it is released the delete goes through.
    await deleteProfile('busy');
    assert.equal(existsSync(profilePath('busy')), false);
  } finally { cleanup(); }
});

test('a profile that is not there is refused by name', async () => {
  const cleanup = sandbox();
  try {
    await assert.rejects(deleteProfile('missing'), /Profile missing does not exist/);
  } finally { cleanup(); }
});

test('a name that is not a profile name is refused before anything is removed', async () => {
  const cleanup = sandbox();
  try {
    createProfile('work');
    await assert.rejects(deleteProfile('../work'), /Profile names/);
    assert.deepEqual(listProfiles(), ['work']);
  } finally { cleanup(); }
});

test('a profile is locked inside its own home, so a delete from another home still sees its holder', async () => {
  const cleanup = sandbox();
  const other = mkdtempSync(join(tmpdir(), 'oc-delete-other-')), previous = process.env.OPTCHAT_HOME;
  try {
    createProfile('work', other);
    // The Pi serving that home, which is what a host with its own data directory runs.
    process.env.OPTCHAT_HOME = other;
    const unlock = await lockProfile(profilePath('work', other), 'work · PID 1 · elsewhere');
    process.env.OPTCHAT_HOME = previous;
    try { await assert.rejects(deleteProfile('work', other), error => error instanceof ProfileBusyError); }
    finally { await unlock(); }
    assert.equal(existsSync(profilePath('work', other)), true, 'the refusal kept every file');
    await deleteProfile('work', other);
    assert.equal(existsSync(profilePath('work', other)), false);
  } finally { process.env.OPTCHAT_HOME = previous; removeDir(other); cleanup(); }
});

test('a Pi that still keeps the lock inside the profile blocks a newer one', async (t) => {
  if (isWindows) return t.skip('the pipe name did not change, so there is no older address to answer on');
  const cleanup = sandbox();
  const legacy = createServer(socket => { socket.on('error', () => socket.destroy()); socket.end('work · PID 9 · older Pi · /tmp'); });
  try {
    createProfile('work');
    await new Promise<void>((resolve, reject) => { legacy.once('error', reject); legacy.listen(join(profilePath('work'), 'lock.sock'), resolve); });
    // The update that moved the lock out must not let a second Pi open the profile the older build is serving.
    await assert.rejects(lockProfile(profilePath('work'), 'newer'), /Profile already running: work · PID 9/);
    await assert.rejects(deleteProfile('work'), /Profile already running: work · PID 9/);
    assert.equal(existsSync(join(profilePath('work'), 'config.json')), true, 'the profile is untouched');
  } finally {
    await new Promise<void>(resolve => legacy.close(() => resolve()));
    cleanup();
  }
});

test('the next delete reclaims a folder an abandoned delete left, and leaves a fresh one alone', async () => {
  const cleanup = sandbox();
  try {
    createProfile('work'); createProfile('other');
    const root = join(dataHome(), 'profiles'), stale = join(root, '.deleting-gone-1699999999999'), fresh = join(root, '.deleting-gone-1');
    mkdirSync(stale); mkdirSync(fresh);
    const long = new Date(Date.now() - 25 * 60 * 60 * 1000);
    utimesSync(stale, long, long);
    await deleteProfile('other');
    assert.equal(existsSync(stale), false, 'a folder old enough to be certain nothing is working on it goes');
    assert.equal(existsSync(fresh), true, 'a delete that may still be finishing is not touched');
  } finally { cleanup(); }
});

test('the delete goes through the acquisition its caller supplies, so a store lease can refuse it', async () => {
  const cleanup = sandbox();
  let held: string | undefined = 'work · PID 1 · elsewhere';
  const store = { lock: { lease: async () => held, heartbeat: async () => {}, release: async () => { held = undefined; } } };
  const take: TakeLock = (dir, description) => holdProfile(store, dir, 'work', description, () => {});
  try {
    createProfile('work');
    await assert.rejects(deleteProfile('work', undefined, take), /Profile already running: work/);
    assert.equal(existsSync(profilePath('work')), true);
    held = undefined;
    await deleteProfile('work', undefined, take);
    assert.equal(existsSync(profilePath('work')), false);
  } finally { cleanup(); }
});
