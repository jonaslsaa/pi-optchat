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
process.on('exit', () => { try { rmSync(root, { recursive: true, force: true }); } catch { /* EBUSY on Windows: leave it */ } });
