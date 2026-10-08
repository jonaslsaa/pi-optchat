import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWrite } from '../src/memory.ts';
import { defaults, loadConfig, lockProfile, ProfileBusyError, saveConfig } from '../src/profiles.ts';

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

test('a failed file flush preserves the previous state and a subsequent write recovers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-flush-'));
  try {
    const file = join(dir, 'state.json'), failure = new Error('injected file flush failure');
    atomicWrite(file, 'previous committed value');
    const flush = mock.method(fs, 'fsyncSync', () => { throw failure; });
    syncBuiltinESMExports();
    assert.throws(() => atomicWrite(file, 'uncommitted replacement'), error => error === failure);
    assert.equal(readFileSync(file, 'utf8'), 'previous committed value');
    flush.mock.restore(); syncBuiltinESMExports();
    atomicWrite(file, 'recovered');
    assert.equal(readFileSync(file, 'utf8'), 'recovered');
    assert.deepEqual(readdirSync(dir), ['state.json']);
  } finally { mock.restoreAll(); syncBuiltinESMExports(); rmSync(dir, { recursive: true, force: true }); }
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
  const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000);
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
    clearTimeout(timeout);
    if (!exited) { child.kill('SIGKILL'); await exit; }
    await unlock?.(); rmSync(dir, { recursive: true, force: true });
  }
});
