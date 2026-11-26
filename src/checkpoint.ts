import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, lstatSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite } from './store.ts';
const exec = promisify(execFile);
// Each checkpoint stores the whole day log again as a loose object. Git's own auto gc counts loose objects, not bytes, and waits for about 6,700 of them (some 1,000 checkpoints), so the checkpoint packs them itself once they pass this size.
const LOOSE_LIMIT_KIB = 16_384;
// A host that stops Pi with SIGTERM and SIGKILL a second later can kill git mid-checkpoint, and git never removes the lock it leaves (#220).
// Index and ref updates take seconds at most, so no live git plausibly holds a lock this old. A younger one may still belong to a git that a
// killed Pi left running (a big `git add` or gc), so that checkpoint is skipped and the next one, after the next turn, looks again.
const STALE_LOCK_MS = 10 * 60_000;
const LOCKS = ['index.lock', 'HEAD.lock', 'refs/heads/main.lock'];
// The subscription's limits as last counted (limits.ts): a new one with nearly every answer, and nothing to keep.
const LOCAL = '/limits.json';

/** Checkpoints own their repository; inherited Git routing must not redirect a write into the caller's repository. */
function checkpointEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
}

function validateCheckpointRepository(directory: string, env: NodeJS.ProcessEnv) {
  const metadata = join(directory, '.git'), entry = lstatSync(metadata, { throwIfNoEntry: false });
  if (!entry) return;
  const invalid = (reason: string) => new Error(`Invalid checkpoint repository at ${metadata}: ${reason}`);
  if (!entry.isDirectory()) throw invalid('.git must be a real directory, not a symlink or file.');
  const probe = spawnSync('git', ['-C', directory, 'rev-parse', '--path-format=absolute', '--absolute-git-dir', '--git-common-dir', '--show-toplevel', '--is-bare-repository'], { encoding: 'utf8', env });
  if (probe.status !== 0) throw invalid(probe.error?.message ?? probe.stderr.trim());
  const paths = probe.stdout.split('\n');
  if (paths.length !== 5 || paths[3] !== 'false' || paths[4] !== '') throw invalid('Expected a non-bare profile-local repository.');
  // Windows can name the same directory with different casing or an 8.3 alias (RUNNER~1). Normalize both sides natively.
  const expected = [metadata, metadata, directory].map(path => realpathSync.native(path));
  if (!paths.slice(0, 3).every((path, index) => realpathSync.native(path) === expected[index]))
    throw invalid('Git directory, common directory and worktree must match the selected profile.');
}

export async function checkpoint(directory: string) {
  const env = checkpointEnvironment();
  const git = (args: string[]) => exec('git', ['-C', directory, ...args], { maxBuffer: 1_000_000, env });
  validateCheckpointRepository(directory, env);
  if (!existsSync(join(directory, '.git'))) {
    await git(['init', '-q', '-b', 'main']);
    validateCheckpointRepository(directory, env);
  }
  if (!existsSync(join(directory, '.gitignore'))) atomicWrite(join(directory, '.gitignore'), '/runs/\n/memory.html\n/usage.jsonl\n*.tmp\n');
  // What is no memory and came after the ignore file, which is written once and may be the user's by now, is left out through git's own list.
  const exclude = join(directory, '.git', 'info', 'exclude'), excluded = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
  if (!excluded.split('\n').includes(LOCAL)) atomicWrite(exclude, `${excluded}${excluded && !excluded.endsWith('\n') ? '\n' : ''}${LOCAL}\n`);
  const locks = LOCKS.flatMap(name => {
    const path = join(directory, '.git', name), stat = statSync(path, { throwIfNoEntry: false });
    return stat ? [{ path, age: Date.now() - stat.mtimeMs }] : [];
  });
  if (locks.some(lock => lock.age < STALE_LOCK_MS)) return;
  // A lock that cannot go (Windows EBUSY) makes git fail below, and the next turn tries again.
  for (const { path } of locks) try { rmSync(path, { force: true }); } catch { /* next turn retries */ }
  await git(['add', '-A', '--', '.']);
  const status = await git(['diff', '--cached', '--name-only']);
  if (!status.stdout.trim()) return;
  await git(['-c', 'user.name=OptChat', '-c', 'user.email=optchat@localhost', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'Save OptChat memory']);
  const loose = Number(/^size: (\d+)$/m.exec((await git(['count-objects', '-v'])).stdout)?.[1]);
  // Cruft packs keep young unreachable objects packed instead of loose, which is the default only from git 2.40; without them every later checkpoint would gc again.
  // A failed gc, such as one blocked by another gc's lock, loses nothing: the commit has landed and the next checkpoint tries again.
  if (loose > LOOSE_LIMIT_KIB) await git(['-c', 'gc.cruftPacks=true', 'gc', '--quiet']).catch(() => {});
}
