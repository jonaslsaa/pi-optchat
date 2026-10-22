import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, rmSync, statSync } from 'node:fs';
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

export async function checkpoint(directory: string) {
  const git = (args: string[]) => exec('git', ['-C', directory, ...args], { maxBuffer: 1_000_000 });
  if (!existsSync(join(directory, '.git'))) await git(['init', '-q', '-b', 'main']);
  if (!existsSync(join(directory, '.gitignore'))) atomicWrite(join(directory, '.gitignore'), '/runs/\n/memory.html\n/usage.jsonl\n*.tmp\n');
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
