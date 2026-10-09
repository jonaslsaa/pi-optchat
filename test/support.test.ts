import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('a test process leaves nothing in the temp dir: not a forgotten dir, not one rewritten after its removal, not a worker thread\'s', () => {
  const temp = mkdtempSync(join(tmpdir(), 'optchat-support-'));
  // Like Pi's image-resize worker: started from a file, so it loads --import again, and terminated, so it never sees 'exit'.
  const worker = join(temp, 'worker.mjs');
  writeFileSync(worker, "import { parentPort } from 'node:worker_threads'; parentPort.postMessage('up'); setInterval(() => {}, 1000);");
  const script = `
    const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
    const { tmpdir } = require('node:os');
    const { join } = require('node:path');
    const { Worker } = require('node:worker_threads');
    mkdtempSync(join(tmpdir(), 'optchat-forgotten-'));
    const late = mkdtempSync(join(tmpdir(), 'optchat-late-'));
    rmSync(late, { recursive: true });
    setTimeout(() => { mkdirSync(late); writeFileSync(join(late, 'auth.json'), '{}'); }, 10);
    const worker = new Worker(${JSON.stringify(worker)});
    worker.on('message', () => worker.terminate());`;
  try {
    execFileSync(process.execPath, ['--import', 'tsx', '--import', new URL('./support.ts', import.meta.url).href, '-e', script],
      { cwd: fileURLToPath(new URL('..', import.meta.url)), env: { ...process.env, TMPDIR: temp, TEMP: temp, TMP: temp } });
    assert.deepEqual(readdirSync(temp).filter(name => name.startsWith('optchat-')), []);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
