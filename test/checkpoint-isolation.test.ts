import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkpoint } from '../src/checkpoint.ts';
import { removeDir } from './support.ts';

const root = mkdtempSync(join(tmpdir(), 'optchat-checkpoint-isolation-'));
after(() => removeDir(root));
const sandbox = () => mkdtempSync(join(root, 'p-'));
// Fixture Git commands always address their own repositories, including while the tested process environment is redirected.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env });
function snapshot(dir: string): Record<string, unknown> {
  return Object.fromEntries(readdirSync(dir).map(name => {
    const path = join(dir, name), stat = lstatSync(path);
    return [name, stat.isSymbolicLink() ? { link: readlinkSync(path) } : stat.isDirectory() ? snapshot(path) : readFileSync(path)];
  }));
}
function application() {
  const dir = sandbox();
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'application.txt'), 'committed application');
  git(dir, 'add', 'application.txt');
  git(dir, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Application');
  writeFileSync(join(dir, 'application.txt'), 'staged application'); git(dir, 'add', 'application.txt');
  writeFileSync(join(dir, 'application.txt'), 'unstaged application');
  return dir;
}
function profile(cwd: string) {
  const dir = join(cwd, 'profiles', 'work'); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'notes.txt'), 'first checkpoint');
  return dir;
}

for (const routing of ['application symlink', 'external symlink', 'gitfile', 'file', 'dangling symlink', 'external worktree', 'external commondir', 'bare', 'incomplete', 'malformed'] as const)
  test(`checkpoint rejects ${routing} before changing the profile or another repository`, async () => {
    const cwd = application(), outside = application(), dir = profile(cwd), metadata = join(dir, '.git');
    const link = (target: string) => symlinkSync(target, metadata, process.platform === 'win32' ? 'junction' : 'dir');
    if (routing === 'application symlink') link(join(cwd, '.git'));
    else if (routing === 'external symlink') link(join(outside, '.git'));
    else if (routing === 'gitfile') writeFileSync(metadata, `gitdir: ${join(outside, '.git')}\n`);
    else if (routing === 'file') writeFileSync(metadata, 'not a repository');
    else if (routing === 'dangling symlink') link(join(outside, 'missing'));
    else if (routing === 'incomplete') mkdirSync(metadata);
    else if (routing === 'bare') git(dir, 'init', '--bare', '-q', metadata);
    else {
      git(dir, 'init', '-q', '-b', 'main');
      if (routing === 'external worktree') git(dir, 'config', 'core.worktree', outside);
      else if (routing === 'external commondir') writeFileSync(join(metadata, 'commondir'), `${join(outside, '.git')}\n`);
      else writeFileSync(join(metadata, 'config'), '[malformed');
    }
    const before = [snapshot(cwd), snapshot(outside)];
    await assert.rejects(checkpoint(dir), /Invalid checkpoint repository/);
    assert.deepEqual([snapshot(cwd), snapshot(outside)], before, 'contents, index, refs and objects stay unchanged');
  });

for (const alias of [false, true]) test(`a nested profile gets its own checkpoint repository and resumes it (directory alias ${alias})`, async () => {
  const cwd = application(), before = snapshot(join(cwd, '.git')), physical = profile(cwd), dir = alias ? join(sandbox(), 'alias') : physical;
  if (alias) symlinkSync(physical, dir, process.platform === 'win32' ? 'junction' : 'dir');
  await checkpoint(dir);
  assert.equal(realpathSync.native(git(dir, 'rev-parse', '--show-toplevel').trim()), realpathSync.native(dir));
  appendFileSync(join(dir, 'notes.txt'), '\nsecond checkpoint'); await checkpoint(dir);
  assert.equal(git(dir, 'rev-list', '--count', 'HEAD').trim(), '2');
  assert.equal(git(dir, 'show', 'HEAD:notes.txt'), 'first checkpoint\nsecond checkpoint');
  assert.deepEqual(snapshot(join(cwd, '.git')), before);
  assert.equal(readFileSync(join(cwd, 'application.txt'), 'utf8'), 'unstaged application');
});

test('a Windows profile can be checkpointed through a differently cased path', { skip: process.platform !== 'win32' }, async () => {
  const dir = profile(application()), alias = dir.toUpperCase();
  assert.notEqual(alias, dir);
  assert.equal(realpathSync.native(alias), realpathSync.native(dir), 'both names address the same directory');
  await checkpoint(alias);
  appendFileSync(join(dir, 'notes.txt'), '\nsecond checkpoint'); await checkpoint(dir);
  assert.equal(git(dir, 'rev-list', '--count', 'HEAD').trim(), '2');
  assert.equal(git(dir, 'show', 'HEAD:notes.txt'), 'first checkpoint\nsecond checkpoint');
});

for (const routing of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS'] as const)
  test(`checkpoint ignores inherited ${routing} when creating and reopening its repository`, async () => {
    const cwd = application(), outside = application(), dir = profile(cwd);
    const values = {
      GIT_DIR: join(outside, '.git'), GIT_WORK_TREE: outside, GIT_COMMON_DIR: join(outside, '.git'),
      GIT_INDEX_FILE: join(outside, '.git', 'index'), GIT_OBJECT_DIRECTORY: join(outside, '.git', 'objects'),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: join(outside, '.git', 'objects'), GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_PARAMETERS: `'core.worktree'='${outside.replaceAll('\\', '/')}'`,
    };
    const overrides = { [routing]: values[routing], ...routing === 'GIT_CONFIG_COUNT' && { GIT_CONFIG_KEY_0: 'core.worktree', GIT_CONFIG_VALUE_0: outside } };
    const saved = Object.keys(overrides).map(key => [key, process.env[key]] as const);
    const before = [snapshot(join(cwd, '.git')), snapshot(outside)];
    try {
      Object.assign(process.env, overrides);
      await checkpoint(dir);
      appendFileSync(join(dir, 'notes.txt'), '\nsecond checkpoint'); await checkpoint(dir);
    } finally { for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
    assert.equal(realpathSync.native(git(dir, 'rev-parse', '--show-toplevel').trim()), realpathSync.native(dir));
    assert.equal(git(dir, 'rev-list', '--count', 'HEAD').trim(), '2');
    assert.equal(git(dir, 'show', 'HEAD:notes.txt'), 'first checkpoint\nsecond checkpoint');
    assert.deepEqual([snapshot(join(cwd, '.git')), snapshot(outside)], before, 'other repositories keep their index, refs, objects and contents');
  });
