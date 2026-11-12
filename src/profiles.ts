import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync, type Stats } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { record } from './core/cache.ts';
import { atomicWrite } from './store.ts';
import type { Store } from './core/store.ts';
import { DEFAULT_SETTINGS, readSettings, type Settings } from './settings.ts';

export const isWindows = process.platform === 'win32';
const PIPE_PREFIX = '\\\\.\\pipe\\';

export const THINKING = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export interface ModelChoice { provider: string; model: string; thinking: typeof THINKING[number] }
export const dataHome = () => resolve(process.env.OPTCHAT_HOME ?? join(homedir(), '.optchat'));
/** `main` is the last model and thinking level picked in Pi while this profile was open, recorded on the first open too. */
export interface ProfileConfig extends Settings { compactor: ModelChoice; subagent: ModelChoice; main?: ModelChoice }
export const defaults: ProfileConfig = {
  compactor: { provider: 'anthropic', model: 'claude-sonnet-5-5', thinking: 'medium' },
  subagent: { provider: 'anthropic', model: 'claude-opus-5-5', thinking: 'high' },
  ...DEFAULT_SETTINGS,
};
const PROFILE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** `home` is OptChat's data directory, `dataHome()` unless a host passes its own. */
export function profilePath(name: string, home = dataHome()) {
  if (!PROFILE_NAME.test(name)) throw new Error('Profile names: 1–64 lowercase letters, digits, hyphens, or underscores.');
  return join(home, 'profiles', name);
}
export function listProfiles(home = dataHome()) {
  const root = join(home, 'profiles');
  return existsSync(root) ? readdirSync(root, { withFileTypes: true }).filter(f => f.isDirectory() && PROFILE_NAME.test(f.name)).map(f => f.name).sort() : [];
}
/** The file in a profile that names its active memory generation. */
export const ACTIVE_MEMORY = 'active-memory.json';
/** A memory generation's directory in profile `dir`: `.` is the profile itself, the others are imports' `memories/<id>`. */
export function generationPath(dir: string, name: string) {
  if (name !== '.' && !/^memories\/[a-f0-9-]{36}$/.test(name)) throw new Error('Invalid memory generation path.');
  return join(dir, name);
}
/** The generation `active-memory.json` points at, which holds the profile's `main/` and `tree/`; without a pointer, the profile itself. */
export function memoryDirectory(dir: string): string {
  const file = join(dir, ACTIVE_MEMORY);
  if (!existsSync(file)) return dir;
  const name: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (typeof name !== 'string') throw new Error('Invalid active memory pointer.');
  const path = generationPath(dir, name);
  if (!existsSync(join(path, 'main'))) throw new Error('Active memory generation is missing.');
  return path;
}
export function createProfile(name: string, home = dataHome()) {
  const dir = profilePath(name, home);
  if (existsSync(dir)) throw new Error(`Profile already exists: ${name}`);
  mkdirSync(resolve(dir, '..'), { recursive: true, mode: 0o700 });
  // Claim the directory exclusively, so a competing creator cannot have its
  // profile overwritten or removed by this attempt's cleanup.
  mkdirSync(dir, { mode: 0o700 });
  try {
    saveConfig(dir, defaults);
    atomicWrite(join(dir, 'AGENTS.md'), `# ${name}\n\nThis is the ${name} profile.\nAdd your personal instructions here.\n`);
  } catch (error) {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); }
    catch { throw new Error(`Failed to create profile ${name}, and could not remove its incomplete directory: ${dir}`, { cause: error }); }
    throw error;
  }
}
export function saveConfig(dir: string, config: ProfileConfig) { atomicWrite(join(dir, 'config.json'), JSON.stringify(config, null, 2) + '\n'); }
function modelChoice(value: unknown): value is ModelChoice {
  return record(value) && typeof value.provider === 'string' && typeof value.model === 'string'
    && THINKING.some(level => level === value.thinking);
}
export function loadConfig(dir: string): ProfileConfig {
  const value: unknown = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
  if (!record(value) || !modelChoice(value.compactor) || !modelChoice(value.subagent) || value.main !== undefined && !modelChoice(value.main)) throw new Error(`Invalid profile config: ${dir}/config.json`);
  const { compactor, subagent, main } = value;
  try { return { compactor, subagent, ...main && { main }, ...readSettings(value) }; }
  catch (error) { throw new Error(`Invalid profile config: ${dir}/config.json: ${error instanceof Error ? error.message : String(error)}`); }
}
export function instructions(dir: string) { return readFileSync(join(dir, 'AGENTS.md'), 'utf8'); }
export function lastProfile() {
  try { const name = readFileSync(join(dataHome(), 'last-profile'), 'utf8').trim(); return listProfiles().includes(name) ? name : undefined; }
  catch { return undefined; }
}
export function rememberProfile(name: string) { atomicWrite(join(dataHome(), 'last-profile'), name); }

export class ProfileBusyError extends Error {
  constructor(readonly owner: string) { super(`Profile already running: ${owner}`); }
}
/** POSIX keeps a socket file in the profile itself, so every Pi on the profile finds the same one whatever its TMPDIR, and Git skips it. Windows has no Unix sockets, so the profile path is hashed into a named pipe in the machine-wide pipe namespace. */
export function profileSocket(dir: string, purpose: 'lock' | 'windows' = 'lock') {
  if (!isWindows) return join(dir, `${purpose}.sock`);
  // Hash the directory's real identity, so another casing, a junction or a symlink to the same profile finds the same pipe.
  let identity = resolve(dir); try { identity = realpathSync.native(identity); } catch {}
  return `${PIPE_PREFIX}optchat-${createHash('sha256').update(identity.toLowerCase()).digest('hex').slice(0, 16)}-${purpose}`;
}

// sun_path is 104 bytes on macOS and 108 elsewhere, both including the NUL; a Windows named pipe path is capped at 259 characters, which for the ASCII names OptChat generates is also its byte length. Node 22 binds a truncated socket instead of failing, so the length is checked before listen.
export const SOCKET_PATH_LIMIT = process.platform === 'darwin' ? 103 : isWindows ? 259 : 107;
export function checkSocketPath(path: string) {
  const length = Buffer.byteLength(path);
  if (length > SOCKET_PATH_LIMIT) throw new Error(`Cannot listen on the profile socket: its path is ${length} bytes, over this system's limit of ${SOCKET_PATH_LIMIT}. Set OPTCHAT_HOME to a shorter directory: ${path}`);
}

/** A socket that may be replaced; a file that only shares its name is refused, never deleted. A Windows pipe has no filesystem entry, so there is nothing to check or remove. */
function existingSocket(path: string): { stat: Stats; removable: true } | { removable: false } | undefined {
  if (isWindows) return { removable: false };
  let stat; try { stat = lstatSync(path); } catch { return undefined; }
  if (!stat.isSocket()) throw new Error(`${path} is not an OptChat socket. Move it out of the profile and try again.`);
  return { stat, removable: true };
}
/** Removes a dead socket left by a previous owner. */
export function removeStaleSocket(path: string) { if (existingSocket(path)?.removable) unlinkSync(path); }

/** Asks the current owner who holds the socket; nothing answering means the entry is stale, and a socket or pipe that is gone (ENOENT) means nobody holds it. */
function readOwner(path: string) {
  return new Promise<string | undefined>((resolve, reject) => {
    const socket = createConnection(path); let message = '';
    socket.setTimeout(1500, () => { socket.destroy(); reject(new Error('Profile lock did not respond; refusing to steal it.')); });
    socket.on('data', data => { message += data.toString(); });
    socket.on('end', () => resolve(message || 'another Pi instance'));
    socket.on('error', e => { if ('code' in e && (e.code === 'ECONNREFUSED' || e.code === 'ENOENT')) resolve(undefined); else reject(e); });
  });
}

/** The Pi holding a profile. */
export interface Owner { profile: string; pid: number; host: string; cwd: string }
/** How Pi describes itself on the lock, which "Profile already running: …" shows. A profile name and a host name can't contain
 * " · ", so `OWNER` reads it back even when the cwd does. */
export const describeOwner = ({ profile, pid, host, cwd }: Owner) => `${profile} · PID ${pid} · ${host} · ${cwd}`;
const OWNER = /^([a-z0-9_-]+) · PID (\d+) · (.*?) · ([\s\S]*)$/;
/** Who holds the profile in `dir`, without taking it; undefined when nobody does. Rejects when the holder doesn't answer within
 * 1.5 seconds or describes itself some other way, so either still counts as busy. */
export async function profileOwner(dir: string): Promise<Owner | undefined> {
  const description = await readOwner(profileSocket(dir));
  if (description === undefined) return undefined;
  const match = OWNER.exec(description);
  if (!match) throw new Error(`Profile is held by ${description}.`);
  const [, profile, pid, host, cwd] = match;
  return { profile, pid: Number(pid), host, cwd };
}

/** OS-owned socket lifetime, no timeout-based stealing of a busy profile. */
export async function lockProfile(dir: string, description: string) {
  const socketPath = profileSocket(dir); checkSocketPath(socketPath);
  const server = createServer(socket => { socket.on('error', () => socket.destroy()); socket.end(description); });
  const listen = () => new Promise<void>((resolve, reject) => {
    const failed = (error: Error) => { server.off('listening', ready); reject(error); };
    const ready = () => { server.off('error', failed); resolve(); };
    server.once('error', failed); server.once('listening', ready); server.listen(socketPath);
  });
  try { await listen(); }
  catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EADDRINUSE') throw error;
    const before = existingSocket(socketPath);
    if (!before) throw new Error('Profile lock changed; try again.');
    const owner = await readOwner(socketPath);
    if (owner !== undefined) throw new ProfileBusyError(owner);
    // Nothing answered, so the entry is stale. POSIX leaves a file behind that can be removed; a Windows pipe disappears with its owner, so rebinding is the whole cleanup.
    if (before.removable) {
      if (statSync(socketPath).ino !== before.stat.ino) throw new Error('Profile lock changed; try again.');
      unlinkSync(socketPath);
    }
    await listen();
  }
  const unlock = () => new Promise<void>(resolve => server.close(() => resolve()));
  if (!isWindows) { try { chmodSync(socketPath, 0o600); } catch (error) { await unlock(); throw error; } }
  return unlock;
}

/** How often a held lease is renewed; a store lets one lapse after about 30 seconds without renewal. */
export const HEARTBEAT_MS = 10_000;
/** Holds the profile until the returned function is called: through the store's lease if it has one, else the machine-local lock. */
export async function holdProfile(store: Pick<Store, 'lock'>, dir: string, profile: string, description: string, warn: (text: string) => void) {
  const { lock } = store;
  if (!lock) return lockProfile(dir, description);
  const owner = await lock.lease(profile, description);
  if (owner !== undefined) throw new ProfileBusyError(owner);
  const beat = setInterval(() => {
    lock.heartbeat().catch((error: unknown) => { warn(`Could not renew the profile lease: ${error instanceof Error ? error.message : String(error)}`); });
  }, HEARTBEAT_MS);
  beat.unref();
  return async () => { clearInterval(beat); await lock.release(); };
}
