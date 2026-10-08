import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWrite } from '../src/memory.ts';
import { defaults, loadConfig, lockProfile, ProfileBusyError, profileSocket, saveConfig } from '../src/profiles.ts';

test('atomic writes replace existing state, preserve UTF-8 and binary data, and leave no temporary files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-write-'));
  try {
    const file = join(dir, 'config.json');
    atomicWrite(file, 'a much longer previous value');
    atomicWrite(file, 'Lars · 日本語');
    assert.equal(readFileSync(file, 'utf8'), 'Lars · 日本語');
    const binary = new Uint8Array([0, 255, 128, 10]);
    atomicWrite(file, binary);
    assert.deepEqual(readFileSync(file), Buffer.from(binary));
    saveConfig(dir, defaults);
    assert.deepEqual(loadConfig(dir), defaults);
    assert.deepEqual(readdirSync(dir), ['config.json']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Windows profile pipes keep one lock through alternate casing and a junction', { skip: process.platform !== 'win32' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'oc-pipes-')), dir = join(root, 'profile'), alias = join(root, 'alias');
  let unlock: (() => Promise<void>) | undefined;
  try {
    mkdirSync(dir);
    symlinkSync(dir, alias, 'junction');
    const pipe = profileSocket(dir);
    assert.ok(pipe.startsWith('\\\\.\\pipe\\optchat-'));
    assert.equal(profileSocket(alias), pipe);
    assert.equal(profileSocket(dir.toUpperCase()), pipe);
    assert.notEqual(profileSocket(dir, 'windows'), pipe);
    assert.notEqual(profileSocket(root), pipe);
    unlock = await lockProfile(dir, 'original owner');
    for (const path of [alias, dir.toUpperCase()]) {
      await assert.rejects(lockProfile(path, 'second writer'), error => error instanceof ProfileBusyError && error.owner === 'original owner');
    }
    assert.ok(!existsSync(join(dir, 'lock.sock')), 'a named pipe creates no socket file');
  } finally { await unlock?.(); rmSync(root, { recursive: true, force: true }); }
});

test('a profile lock is released by the OS when its owning process is killed', { timeout: 20_000 }, async () => {
  // macOS's default TMPDIR can exceed the Unix socket path limit.
  const dir = mkdtempSync(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'oc-crash-'));
  const moduleUrl = new URL('../src/profiles.ts', import.meta.url).href;
  const script = `import { lockProfile } from ${JSON.stringify(moduleUrl)}; await lockProfile(process.argv[1], 'child owner'); process.send('ready');`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, dir], {
    cwd: new URL('..', import.meta.url), stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '', exited = false;
  child.stderr!.on('data', data => { stderr = (stderr + data.toString()).slice(-4000); });
  const exit = once(child, 'exit').then(() => { exited = true; });
  let unlock: (() => Promise<void>) | undefined;
  try {
    await Promise.race([
      once(child, 'message').then(([message]) => { assert.equal(message, 'ready'); }),
      exit.then(() => { throw new Error(`Lock owner exited before readiness: ${stderr}`); }),
    ]);
    await assert.rejects(lockProfile(dir, 'competitor'), error => error instanceof ProfileBusyError && error.owner === 'child owner');
    child.kill('SIGKILL'); await exit;
    unlock = await lockProfile(dir, 'replacement owner');
    await assert.rejects(lockProfile(dir, 'another writer'), /replacement owner/);
  } finally {
    if (!exited) { child.kill('SIGKILL'); await exit; }
    await unlock?.(); rmSync(dir, { recursive: true, force: true });
  }
});
