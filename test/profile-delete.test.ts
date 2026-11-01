import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProfile, deleteProfile, lastProfile, listProfiles, lockProfile, profilePath, ProfileBusyError, rememberProfile } from '../src/profiles.ts';
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
    assert.equal(fs.existsSync(profilePath('work')), false);
    assert.deepEqual(listProfiles(), ['home']);
    assert.equal(lastProfile(), undefined);
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
    fs.writeFileSync(join(profilePath('busy'), 'main.jsonl'), 'my memory');
    const unlock = await lockProfile(profilePath('busy'), 'busy · PID 1234 · this machine');
    try {
      await assert.rejects(deleteProfile('busy'), error => error instanceof ProfileBusyError);
    } finally { await unlock(); }
    assert.equal(fs.readFileSync(join(profilePath('busy'), 'main.jsonl'), 'utf8'), 'my memory');
    // The refusal is about the holder, not the profile: once it is released the delete goes through.
    await deleteProfile('busy');
    assert.equal(fs.existsSync(profilePath('busy')), false);
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
