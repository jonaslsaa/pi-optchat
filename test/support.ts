import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

// Every temp dir made through os.tmpdir() lands in this root, removed at exit. It also takes what a test's own cleanup misses: Pi rewrites auth.json after a test removed its dir, and a worker thread loads this file again but is terminated before 'exit'.
// macOS's default tmpdir is ~49 chars, and the extra level would push profile lock-socket paths past the 103-byte limit, so the outermost root goes under /tmp there. A child process or worker thread nests inside its parent's root, so it goes away with it even if it never reaches 'exit'.
const nested = basename(tmpdir()).startsWith('optchat-test-');
const root = mkdtempSync(join(process.platform === 'darwin' && !nested ? '/tmp' : tmpdir(), 'optchat-test-'));
for (const name of ['TMPDIR', 'TEMP', 'TMP']) process.env[name] = root;
// os.homedir() reads HOME on POSIX and USERPROFILE on Windows, so both are sandboxed: no test may touch the user's real ~/.optchat or ~/.pi.
for (const name of ['HOME', 'USERPROFILE', 'OPTCHAT_HOME', 'PI_CODING_AGENT_DIR']) process.env[name] = mkdtempSync(join(root, `optchat-${name.toLowerCase()}-`));

/** Removes a test's temp dir. On Windows a process that just exited can hold its cwd a moment longer than `process.kill(pid, 0)` admits, so rmdir fails with EBUSY (#164). rmSync's own `maxRetries` doesn't cover that: it retries only after ENOTEMPTY, not a first rmdir that fails EBUSY. */
export function removeDir(path: string) {
  for (let attempt = 1; ; attempt++) {
    try { return rmSync(path, { recursive: true, force: true }); } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt === 10 || !(code === 'EBUSY' || code === 'EPERM' || code === 'ENOTEMPTY')) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}

process.on('exit', () => { try { rmSync(root, { recursive: true, force: true }); } catch { /* EBUSY on Windows: leave it */ } });
