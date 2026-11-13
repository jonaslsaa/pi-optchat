import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, type Stats } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createConnection, createServer } from 'node:net';
import { homedir } from 'node:os';
import { record } from './core/cache.ts';
import { atomicWrite } from './store.ts';
import type { Store } from './core/store.ts';
import { DEFAULT_SETTINGS, invalid, readSettings, SETTING_KEYS, type Settings } from './settings.ts';

export const isWindows = process.platform === 'win32';
const PIPE_PREFIX = '\\\\.\\pipe\\';

export const THINKING = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export interface ModelChoice { provider: string; model: string; thinking: typeof THINKING[number] }
export const dataHome = () => resolve(process.env.OPTCHAT_HOME ?? join(homedir(), '.optchat'));
/** `main` is the last model and thinking level picked in Pi while this profile was open, recorded on the first open too. */
export interface ProfileConfig extends Settings { compactor: ModelChoice; subagent: ModelChoice; main?: ModelChoice }
/** A new profile's config. One shared object: copy it, don't change it. */
export const defaults: ProfileConfig = {
  compactor: { provider: 'anthropic', model: 'claude-sonnet-5-5', thinking: 'medium' },
  subagent: { provider: 'anthropic', model: 'claude-opus-5-5', thinking: 'high' },
  ...DEFAULT_SETTINGS,
};
/** What profilePath() accepts, listProfiles() returns and a picker row carries. */
export const PROFILE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** `home` is OptChat's data directory, `dataHome()` unless a host passes its own. */
export function profilePath(name: string, home = dataHome()) {
  if (!PROFILE_NAME.test(name)) throw new Error('Profile names: 1–64 lowercase letters, digits, hyphens, or underscores.');
  return join(home, 'profiles', name);
}
export function listProfiles(home = dataHome()) {
  const root = join(home, 'profiles');
  return existsSync(root) ? readdirSync(root, { withFileTypes: true }).filter(f => f.isDirectory() && PROFILE_NAME.test(f.name)).map(f => f.name).sort() : [];
}
/** How a caller takes a profile: the machine-local lock, or a host's store lease when its store enforces one. */
export type TakeLock = (dir: string, description: string) => Promise<() => Promise<void>>;
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
/** How long a folder an abandoned delete left behind is kept, so no attempt that is still finishing can be swept. */
const ABANDONED_AFTER_MS = 24 * 60 * 60 * 1000;
/** A delete that fails between the rename and the removal leaves `.deleting-<name>-<time>` under `profiles/`, which no picker shows. The next delete reclaims ones old enough to be certain nothing is still working on them. */
function sweepAbandoned(home: string) {
  const root = join(home, 'profiles');
  let entries: string[]; try { entries = readdirSync(root); } catch { return; }
  for (const entry of entries) {
    if (!entry.startsWith('.deleting-')) continue;
    const path = join(root, entry);
    try { if (Date.now() - statSync(path).mtimeMs > ABANDONED_AFTER_MS) rmSync(path, { recursive: true, force: true, maxRetries: 3 }); } catch { /* Another delete is removing it, or it is already gone. */ }
  }
}
/** Windows refuses to rename a folder a program holds a file in (EPERM, EBUSY), and an indexer or a scan can hold one for a moment, so the move retries the way the removal below does. */
async function moveAside(dir: string, reserved: string, name: string) {
  for (let attempt = 1; ; attempt++) {
    try { return renameSync(dir, reserved); } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const retry = code === 'EBUSY' || code === 'EPERM' || code === 'ENOTEMPTY' || code === 'EACCES';
      if (!retry) throw error;
      if (attempt === 10) throw new Error(`Could not move ${name} aside to delete it: close anything using its folder and try again (${code}).`, { cause: error });
      await sleep(100);
    }
  }
}
/** Removes a profile's folder, and the saved last-profile pointer when it names it. The lock decides: a profile another Pi is using is open, so deleting it would leave that Pi writing into a folder that is gone. */
export async function deleteProfile(name: string, home = dataHome(), take: TakeLock = lockProfile) {
  const dir = profilePath(name, home);
  if (!existsSync(dir)) throw new Error(`Profile ${name} does not exist.`);
  sweepAbandoned(home);
  const unlock = await take(dir, 'deleting');
  try {
    // Renamed to a hidden sibling before the rmSync: a delete that fails on Windows then cannot leave half a profile in the picker (listProfiles() hides dot names).
    const reserved = join(home, 'profiles', `.deleting-${name}-${Date.now()}`);
    await moveAside(dir, reserved, name);
    // listProfiles() already hides a name with no folder, but without this a profile created again under the same name would inherit the stale pointer.
    // Clear it immediately after the rename, before the recursive removal, so an rmSync failure cannot leave a stale pointer behind.
    const last = join(home, 'last-profile');
    try { if (readFileSync(last, 'utf8').trim() === name) unlinkSync(last); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    rmSync(reserved, { recursive: true, force: true, maxRetries: 3 });
    return dir;
  } finally { await unlock(); }
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
/** Saves a change and applies it to `config`, the object a running Pi reads its settings from; throws if it can't be written. */
export function applyConfig(dir: string, config: ProfileConfig, patch: Partial<ProfileConfig>) {
  saveConfig(dir, { ...config, ...patch });
  Object.assign(config, patch);
}
function modelChoice(value: unknown): value is ModelChoice {
  return record(value) && typeof value.provider === 'string' && typeof value.model === 'string'
    && THINKING.some(level => level === value.thinking);
}
export const loadConfig = (dir: string) => parseConfig(dir, JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')));
function parseConfig(dir: string, value: unknown): ProfileConfig {
  if (!record(value) || !modelChoice(value.compactor) || !modelChoice(value.subagent) || value.main !== undefined && !modelChoice(value.main)) throw new Error(`Invalid profile config: ${dir}/config.json`);
  const { compactor, subagent, main } = value;
  try { return { compactor, subagent, ...main && { main }, ...readSettings(value) }; }
  catch (error) { throw new Error(`Invalid profile config: ${dir}/config.json: ${error instanceof Error ? error.message : String(error)}`); }
}
/** What another app may change: any setting, and the compactor or subagent model. The main model follows Pi's own pick. */
export type ConfigPatch = Partial<Omit<ProfileConfig, 'main'>>;
/** Checks a change as the settings page would; throws the first reason it can't be used. */
export function checkPatch(patch: unknown): asserts patch is ConfigPatch {
  if (!record(patch)) throw new Error('A config change must be an object.');
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'main') throw new Error('The main model follows Pi: pick it there (RPC set_model), and Pi saves it to the profile.');
    if (key === 'compactor' || key === 'subagent') {
      if (!modelChoice(value)) throw new Error(`${key} must be { provider, model, thinking }, thinking one of ${THINKING.join(', ')}.`);
      continue;
    }
    const setting = SETTING_KEYS.find(known => known === key);
    if (!setting) throw new Error(`Unknown setting: ${key}.`);
    const problem = invalid(setting, value);
    if (problem) throw new Error(problem);
  }
}
/** A change to config.json while no Pi holds the profile (call only under its lock). Keys this copy doesn't know stay as they are. */
export function patchConfigFile(dir: string, patch: ConfigPatch) {
  const raw: unknown = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
  if (!record(raw)) throw new Error(`Invalid profile config: ${dir}/config.json`);
  const next = { ...raw, ...patch }, config = parseConfig(dir, next);
  atomicWrite(join(dir, 'config.json'), JSON.stringify(next, null, 2) + '\n');
  return config;
}
export function readInstructions(dir: string) { return readFileSync(join(dir, 'AGENTS.md'), 'utf8'); }
/** The profile's instructions, read again each turn, so a save applies from the next one. */
export function saveInstructions(dir: string, text: string) { atomicWrite(join(dir, 'AGENTS.md'), text); }
export function lastProfile() {
  try { const name = readFileSync(join(dataHome(), 'last-profile'), 'utf8').trim(); return listProfiles().includes(name) ? name : undefined; }
  catch { return undefined; }
}
export function rememberProfile(name: string) { atomicWrite(join(dataHome(), 'last-profile'), name); }

export class ProfileBusyError extends Error {
  constructor(readonly owner: string) { super(`Profile already running: ${owner}`); }
}
/**
 * The lock lives outside the profile directory so a deletion can rename the profile away without moving the socket.
 * An old server's close therefore cannot unlink a replacement owner's socket at the same path.
 * POSIX keeps one socket per profile beside the profiles it guards, named by the directory's real identity, so every Pi on
 * the profile finds the same one whatever its TMPDIR, its home or its spelling of the path, and Git never sees it.
 * Windows has no Unix sockets, so the same identity becomes a named pipe in the machine-wide pipe namespace.
 */
export function profileSocket(dir: string, purpose: 'lock' | 'windows' = 'lock') {
  if (!isWindows && purpose !== 'lock') return join(dir, `${purpose}.sock`);
  // The directory's real identity, so another casing, a junction, a symlink or a host's own data home finds the same lock.
  let identity = resolve(dir); try { identity = realpathSync.native(identity); } catch {}
  const hash = createHash('sha256').update(isWindows ? identity.toLowerCase() : identity).digest('hex').slice(0, 16);
  // The socket's own directory follows the resolved path too, so two spellings of one home reach one socket as well.
  return isWindows ? `${PIPE_PREFIX}optchat-${hash}-${purpose}` : join(dirname(identity), '.locks', `${hash}.sock`);
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
  if (!stat.isSocket()) throw new Error(`${path} is not an OptChat socket. Move it out of the way and try again.`);
  return { stat, removable: true };
}
/** Removes a dead socket left by a previous owner. */
export function removeStaleSocket(path: string) { if (existingSocket(path)?.removable) unlinkSync(path); }

/** Asks the current owner who holds the socket; nothing answering means the entry is stale, and a socket or pipe that is gone (ENOENT) means nobody holds it. `lenient` also treats a file that is not a socket at all as nobody: a leftover, not a holder. */
function readOwner(path: string, lenient = false) {
  return new Promise<string | undefined>((resolve, reject) => {
    const socket = createConnection(path); let message = '';
    socket.setTimeout(1500, () => { socket.destroy(); reject(new Error('Profile lock did not respond; refusing to steal it.')); });
    socket.on('data', data => { message += data.toString(); });
    socket.on('end', () => resolve(message || 'another Pi instance'));
    socket.on('error', e => { if (lenient || 'code' in e && (e.code === 'ECONNREFUSED' || e.code === 'ENOENT')) resolve(undefined); else reject(e); });
  });
}

/** The socket name a build from before the lock moved out of the profile folder listened on. */
const LOCK_FILE = 'lock.sock';
/** Who holds a profile's lock through a build that kept it inside the profile folder; undefined when nobody does or when there is no such socket. */
async function legacyOwner(dir: string) {
  if (isWindows) return undefined; // The pipe name has not changed, so there is no older address to ask.
  const path = join(dir, LOCK_FILE);
  if (!existsSync(path)) return undefined;
  const owner = await readOwner(path, true);
  // Nothing answered, so the file is a leftover a crashed owner left in the profile and would only be mistaken for a holder later: it goes. A regular file that merely shares the name is left alone.
  if (owner === undefined) { try { if (lstatSync(path).isSocket()) unlinkSync(path); } catch { /* Someone else removed it. */ } }
  return owner;
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
  if (!isWindows) mkdirSync(dirname(socketPath), { recursive: true });
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
  // A build from before the lock moved out of the profile still answers on its own socket, and two Pis on one profile is what the lock exists to stop.
  let legacy: string | undefined;
  try { legacy = await legacyOwner(dir); }
  catch (error) { await unlock(); throw error; }
  if (legacy !== undefined) { await unlock(); throw new ProfileBusyError(legacy); }
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
