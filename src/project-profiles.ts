import { spawnSync } from 'node:child_process';
import { appendFileSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { record } from './core/cache.ts';
import { checkSocketPath, createProfileDirectory, profilePath, profileSocket } from './profiles.ts';

export interface ProjectProfile { kind: 'project'; dir: string }
export type ProfileSelection = string | ProjectProfile;
const relative = '.pi/optchat';
const outputLine = (text: string) => text.replace(/\r?\n$/, '');
const environment = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
function git(cwd: string, args: string[]) {
  return spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 3000, env: { ...environment(), LC_ALL: 'C' } });
}
/** Git resolves subdirectories, submodules and linked worktrees to their own root. Discovery never creates a profile. */
export function projectLocation(cwd: string): ProjectProfile | undefined {
  const result = git(cwd, ['rev-parse', '--show-toplevel']);
  if (result.status !== 0) {
    if ((result.error && 'code' in result.error && result.error.code === 'ENOENT') || /not a git repository|must be run in a work tree/.test(result.stderr ?? '')) return undefined;
    throw new Error(`Could not find the project root: ${result.error?.message ?? result.stderr.trim()}`);
  }
  return { kind: 'project', dir: join(realpathSync(outputLine(result.stdout)), '.pi', 'optchat') };
}
function projectRoot(profile: ProjectProfile) {
  const dir = profile.dir;
  if (!isAbsolute(dir) || resolve(dir) !== dir || basename(dir) !== 'optchat' || basename(dirname(dir)) !== '.pi')
    throw new Error('Invalid project profile binding.');
  return dirname(dirname(dir));
}
export function resolveProfile(profile: ProfileSelection) {
  if (typeof profile === 'string') return { name: profile, dir: profilePath(profile) };
  const root = projectRoot(profile);
  return { name: basename(root).replace(/[\x00-\x1f\x7f-\x9f]/g, '?') || root, dir: profile.dir };
}
export const profileBinding = (profile: ProfileSelection) => typeof profile === 'string' ? { name: profile } : profile;
export function parseProfileBinding(value: unknown): ProfileSelection | undefined {
  if (!record(value)) return undefined;
  if (value.kind === 'project') {
    if (typeof value.dir !== 'string') throw new Error('Invalid project profile binding.');
    const profile: ProjectProfile = { kind: 'project', dir: value.dir }; projectRoot(profile); return profile;
  }
  return typeof value.name === 'string' ? value.name : undefined;
}
export const sameProfile = (a: ProfileSelection | undefined, b: ProfileSelection) => a !== undefined
  && (typeof a === 'string' || typeof b === 'string' ? a === b : a.dir === b.dir);

function directory(path: string) {
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (entry && !entry.isDirectory()) throw new Error(`Project profile requires a real directory, not a file or symlink: ${path}`);
  return entry !== undefined;
}
function present(profile: ProjectProfile) {
  projectRoot(profile);
  if (!directory(dirname(profile.dir)) || !directory(profile.dir)) return false;
  directory(join(profile.dir, '.git')); // Checkpoints must not follow a linked Git directory.
  return true;
}
export function discoverProjectProfile(cwd: string) {
  const profile = projectLocation(cwd);
  return profile && present(profile) ? profile : undefined;
}
/** Keep private memory out of the source repository without editing tracked .gitignore files. */
function protect(profile: ProjectProfile) {
  const root = projectRoot(profile), current = projectLocation(root);
  if (!current || current.dir !== profile.dir) return; // A saved session may outlive its source repository.
  const tracked = git(root, ['ls-files', '--', relative]);
  if (tracked.status !== 0 || tracked.stdout) throw new Error('Project profile files are tracked by Git. Remove them from the index before opening this profile.');
  const ignored = () => {
    const probe = git(root, ['check-ignore', '--no-index', '-q', '--', `${relative}/`]);
    if (probe.status !== 0 && probe.status !== 1) throw new Error(`Could not check project ignores: ${probe.error?.message ?? probe.stderr.trim()}`);
    return probe.status === 0;
  };
  if (ignored()) return;
  const found = git(root, ['rev-parse', '--path-format=absolute', '--git-path', 'info/exclude']);
  if (found.status !== 0) throw new Error(`Could not find Git's exclude file: ${found.error?.message ?? found.stderr.trim()}`);
  const path = outputLine(found.stdout), stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat && !stat.isFile()) throw new Error(`Git's exclude file must be a regular file: ${path}`);
  const text = stat ? readFileSync(path, 'utf8') : '', newline = text.includes('\r\n') ? '\r\n' : '\n';
  mkdirSync(dirname(path), { recursive: true });
  if (!text.split(/\r?\n/).includes(`/${relative}/`)) appendFileSync(path, `${text && !text.endsWith('\n') ? newline : ''}/${relative}/${newline}`);
  if (!ignored()) throw new Error(`Project .gitignore rules expose ${relative}. Add /${relative}/ to the project .gitignore before opening its profile.`);
}
export function prepareProjectProfile(profile: ProfileSelection) {
  if (typeof profile === 'string') return;
  if (!present(profile)) throw new Error(`Project profile does not exist: ${profile.dir}`);
  checkSocketPath(profileSocket(profile.dir)); checkSocketPath(profileSocket(profile.dir, 'windows'));
  protect(profile);
}
export function createProjectProfile(cwd: string): ProjectProfile {
  const profile = projectLocation(cwd);
  if (!profile) throw new Error('Project profiles require a Git worktree.');
  if (present(profile)) { prepareProjectProfile(profile); return profile; }
  checkSocketPath(profileSocket(profile.dir)); checkSocketPath(profileSocket(profile.dir, 'windows'));
  protect(profile);
  createProfileDirectory(profile.dir, resolveProfile(profile).name);
  return profile;
}
