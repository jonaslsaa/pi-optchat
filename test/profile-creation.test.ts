import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProfile, defaults, instructions, listProfiles, loadConfig, profilePath } from '../src/profiles.ts';

function sandbox() {
  const dir = fs.mkdtempSync(join(tmpdir(), 'oc-create-')), previous = process.env.OPTCHAT_HOME;
  process.env.OPTCHAT_HOME = dir;
  return () => {
    mock.restoreAll(); syncBuiltinESMExports();
    if (previous === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  };
}

for (const stage of ['config', 'instructions'] as const) {
  test(`failed ${stage} write leaves no profile and the same name can be retried`, () => {
    const cleanup = sandbox(), failure = new Error(`injected ${stage} fsync failure`);
    try {
      const original = fs.fsyncSync;
      // Unix also syncs the directory after each file; Windows only syncs the file.
      const failAt = stage === 'config' ? 1 : process.platform === 'win32' ? 2 : 3;
      let calls = 0;
      const flush = mock.method(fs, 'fsyncSync', (fd: number) => {
        if (++calls === failAt) throw failure;
        return original(fd);
      });
      syncBuiltinESMExports();
      assert.throws(() => createProfile('retry'), error => error === failure);
      assert.ok(!fs.existsSync(profilePath('retry')));
      assert.deepEqual(listProfiles(), []);
      flush.mock.restore(); syncBuiltinESMExports();
      createProfile('retry');
      assert.deepEqual(loadConfig(profilePath('retry')), defaults);
      assert.match(instructions(profilePath('retry')), /This is the retry profile/);
      assert.deepEqual(fs.readdirSync(profilePath('retry')).sort(), ['AGENTS.md', 'config.json']);
    } finally { cleanup(); }
  });
}

test('an existing profile is preserved when creation is refused', () => {
  const cleanup = sandbox();
  try {
    const dir = profilePath('existing'); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(join(dir, 'notes.txt'), 'keep my data');
    assert.throws(() => createProfile('existing'), /Profile already exists/);
    assert.deepEqual(fs.readdirSync(dir), ['notes.txt']);
    assert.equal(fs.readFileSync(join(dir, 'notes.txt'), 'utf8'), 'keep my data');
  } finally { cleanup(); }
});

test('a competing creator that claims the directory first keeps its files', () => {
  const cleanup = sandbox();
  try {
    const dir = profilePath('race'), original = fs.mkdirSync;
    mock.method(fs, 'mkdirSync', (path: fs.PathLike, options?: fs.MakeDirectoryOptions) => {
      if (path === dir) {
        original(dir);
        fs.writeFileSync(join(dir, 'notes.txt'), 'other creator');
      }
      return original(path, options);
    });
    syncBuiltinESMExports();
    assert.throws(() => createProfile('race'), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'EEXIST');
    assert.deepEqual(fs.readdirSync(dir), ['notes.txt']);
    assert.equal(fs.readFileSync(join(dir, 'notes.txt'), 'utf8'), 'other creator');
  } finally { cleanup(); }
});
