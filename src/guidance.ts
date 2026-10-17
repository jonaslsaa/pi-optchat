import { createHash } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync, readSync, lstatSync, linkSync, mkdirSync } from 'node:fs';
import { basename, dirname, join, resolve, relative, isAbsolute } from 'node:path';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { getCurrentSystemMessage, getSystemMessageText } from '@earendil-works/pi-ai';
import { getAgentDir, loadProjectContextFiles, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { atomicWrite } from './store.ts';
import { isAtWork } from './cache.ts';

export const GUIDANCE_STATE = 'optchat.guidance';
const LIMIT = 1_000_000;
const CANDIDATES = ['AGENTS.override.md', 'AGENTS.md', 'AGENTS.MD', 'CLAUDE.md', 'CLAUDE.MD'];
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const normalize = (text: string) => text.replace(/^\uFEFF/, '');
const xml = (text: string) => text.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
export interface GuidanceSource { path: string; scope: string; content: string; supplied: string; modified: string }
export interface GuidanceFile { path: string; scope: string; version: string; archive: string; supplied: string }
export interface GuidanceRevision { id: string; files: GuidanceFile[] }
interface Transition { before: string; after: string; anchor: string; occurrence?: number }
export interface GuidanceState { revision: GuidanceRevision; transitions: Transition[] }

/** Read once through one handle. Never truncate, silently fall back, or mistake a failed read for deletion. */
function readSource(path: string, scope: string): GuidanceSource | undefined {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // A dangling symlink is a broken source, not a deliberate removal.
      try { lstatSync(path); } catch (missing) { if ((missing as NodeJS.ErrnoException).code === 'ENOENT') return undefined; }
    }
    throw new Error(`Cannot read current guidance ${path}: ${String(error)}`);
  }
  try {
    const before = fstatSync(fd);
    if (!before.isFile()) throw new Error('not a regular file');
    if (before.size > LIMIT) throw new Error(`exceeds ${LIMIT.toLocaleString('en-US')} bytes; no partial guidance will be sent`);
    const buffer = Buffer.alloc(Math.min(before.size + 1, LIMIT + 1));
    const length = readSync(fd, buffer, 0, buffer.length, 0), bytes = buffer.subarray(0, length), after = fstatSync(fd);
    if (bytes.length > LIMIT || bytes.length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
      throw new Error('changed while being read; retry the request');
    const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    return { path: resolve(path), scope, content, supplied: normalize(content), modified: after.mtime.toISOString() };
  } catch (error) { throw new Error(`Cannot read current guidance ${path}: ${String(error)}`); }
  finally { closeSync(fd); }
}

/** Match Pi's candidate priority, global → ancestors → cwd ordering and linked-worktree shadowing.
 * Pi's loader warns and skips unreadable sources; preflight prevents that weaker guarantee here. */
export function currentGuidance(cwd: string, profile: string, agentDir = getAgentDir(), discover = true): GuidanceSource[] {
  const archived = (path: string) => {
    const part = relative(join(profile, 'guidance', 'sources'), resolve(path));
    return !isAbsolute(part) && part !== '..' && !part.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`);
  };
  const dirs = new Set(discover ? [resolve(agentDir)] : []);
  if (discover) for (let dir = resolve(cwd); ; dir = dirname(dir)) { dirs.add(dir); if (dirname(dir) === dir) break; }
  const checked = new Map<string, GuidanceSource>();
  for (const dir of dirs) {
    if (archived(dir)) continue;
    for (const name of CANDIDATES) {
      const source = readSource(join(dir, name), dir === resolve(agentDir) ? 'global' : `project:${dir}`);
      if (source) { checked.set(source.path, source); break; }
    }
  }
  const files = (discover ? loadProjectContextFiles({ cwd, agentDir }) : []).filter(file => !archived(file.path)).map(file => {
    const source = checked.get(resolve(file.path));
    if (!source || source.supplied !== file.content) throw new Error(`Guidance changed during discovery: ${file.path}; retry the request`);
    return source;
  });
  const personal = readSource(join(profile, 'AGENTS.md'), `profile:${resolve(profile)}`);
  if (personal) {
    // Profile instructions have always followed project instructions, even when the profile is the cwd.
    const duplicate = files.findIndex(file => file.path === personal.path);
    if (duplicate >= 0) files.splice(duplicate, 1);
    files.push(personal);
  }
  if (files.reduce((sum, file) => sum + Buffer.byteLength(file.supplied), 0) > LIMIT)
    throw new Error(`Current guidance exceeds ${LIMIT.toLocaleString('en-US')} bytes in total; no partial guidance will be sent`);
  return files;
}

/** Immutable, human-readable source copies. Metadata and supplied text are separate from the original bytes. */
export class GuidanceArchive {
  readonly directory: string;
  constructor(profile: string) { this.directory = join(profile, 'guidance'); }
  preserve(sources: GuidanceSource[]): GuidanceRevision {
    const files = sources.map(source => {
      const version = hash(source.content);
      const label = source.path.replace(/[^a-zA-Z0-9._-]+/g, '%').slice(-48);
      const dir = join(this.directory, 'sources', `${label}-${hash(source.path).slice(0, 16)}`, version);
      const archive = join(dir, basename(source.path));
      const supplied = source.content === source.supplied ? archive : join(dir, 'supplied.txt');
      const keep = (path: string, text: string) => {
        const object = join(this.directory, 'contents', `${hash(text)}.txt`);
        if (existsSync(object)) { if (readFileSync(object, 'utf8') !== text) throw new Error(`Damaged guidance content: ${object}`); }
        else atomicWrite(object, text);
        if (existsSync(path)) { if (readFileSync(path, 'utf8') !== text) throw new Error(`Damaged guidance archive: ${path}`); }
        else {
          mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
          linkSync(object, path); // Same bytes once, with a recognizable name at every original source location.
        }
      };
      keep(archive, source.content);
      if (supplied !== archive) keep(supplied, source.supplied);
      const metadata = join(dir, 'metadata.json');
      if (!existsSync(metadata)) atomicWrite(metadata, JSON.stringify({ source: source.path, version, modified: source.modified,
        captured: new Date().toISOString(), transformation: supplied === archive ? 'none' : 'leading UTF-8 BOM removed', supplied: basename(supplied) }, null, 2));
      return { path: source.path, scope: source.scope, version, archive, supplied };
    });
    const stored = files.map(file => ({ ...file, archive: relative(this.directory, file.archive).split('\\').join('/'), supplied: relative(this.directory, file.supplied).split('\\').join('/') }));
    const id = hash(JSON.stringify(stored));
    const file = join(this.directory, 'revisions', `${id}.json`), text = JSON.stringify({ id, files: stored }, null, 2);
    if (existsSync(file)) { if (readFileSync(file, 'utf8') !== text) throw new Error(`Damaged guidance revision: ${file}`); }
    else atomicWrite(file, text);
    return { id, files };
  }
  revision(id: string): GuidanceRevision {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid guidance revision');
    const revision = JSON.parse(readFileSync(join(this.directory, 'revisions', `${id}.json`), 'utf8')) as GuidanceRevision;
    if (revision.id !== id || hash(JSON.stringify(revision.files)) !== id) throw new Error(`Damaged guidance revision: ${id}`);
    const locate = (path: string) => {
      if (isAbsolute(path) || path.split(/[\\/]/).includes('..')) throw new Error(`Invalid guidance archive path: ${path}`);
      return join(this.directory, path);
    };
    const files = revision.files.map(file => ({ ...file, archive: locate(file.archive), supplied: locate(file.supplied) }));
    for (const file of files) {
      const raw = readFileSync(file.archive, 'utf8');
      if (hash(raw) !== file.version || readFileSync(file.supplied, 'utf8') !== normalize(raw)) throw new Error(`Damaged historical guidance: ${file.archive}`);
    }
    return { ...revision, files };
  }
}

const quote = (text: string) => JSON.stringify(text.replace(/\s+/g, ' ').trim().slice(0, 160));
/** Mechanical excerpts, never a guessed semantic summary. Counts make broader edits explicit. */
function difference(before: GuidanceRevision, after: GuidanceRevision) {
  const changes: string[] = [];
  for (const old of before.files) {
    const next = after.files.find(file => file.path === old.path);
    if (!next) { changes.push(`${old.path} no longer applies`); continue; }
    if (old.version !== next.version) {
      const a = readFileSync(old.supplied, 'utf8').split('\n'), b = readFileSync(next.supplied, 'utf8').split('\n');
      const oldLines = new Set(a), newLines = new Set(b);
      const removed = a.filter(line => line.trim() && !newLines.has(line)), added = b.filter(line => line.trim() && !oldLines.has(line));
      changes.push(`${old.path}: ${removed.length || added.length ? `${removed.length} previous lines absent from current text and ${added.length} current lines absent from previous text` : 'line ordering, repetition or whitespace changed'} (previous excerpt ${quote(removed[0] ?? a.join('\n'))}; current excerpt ${quote(added[0] ?? b.join('\n'))}; excerpts are not an exhaustive description)`);
    }
  }
  for (const file of after.files) if (!before.files.some(old => old.path === file.path)) changes.push(`${file.path} now applies`);
  if (JSON.stringify(before.files.map(f => [f.path, f.scope])) !== JSON.stringify(after.files.map(f => [f.path, f.scope])))
    changes.push('the applicable sources, scopes or ordering changed');
  return `${changes.slice(0, 4).join('; ')}${changes.length > 4 ? `; ${changes.length - 4} additional source/order changes (consult the full revisions)` : ''}.`;
}

/** Source bytes can change without changing supplied instructions (for example, adding a BOM). */
function sameEffectiveGuidance(before: GuidanceRevision, after: GuidanceRevision) {
  return before.files.length === after.files.length && before.files.every((old, index) => {
    const next = after.files[index];
    return old.path === next.path && old.scope === next.scope &&
      (old.version === next.version || readFileSync(old.supplied, 'utf8') === readFileSync(next.supplied, 'utf8'));
  });
}

export function guidanceKey(message: AgentMessage) {
  return hash(JSON.stringify(message));
}
export function guidanceState(ctx: ExtensionContext): GuidanceState | undefined {
  const entry = ctx.sessionManager.getBranch().findLast(e => e.type === 'custom' && e.customType === GUIDANCE_STATE);
  if (!entry || entry.type !== 'custom') return undefined;
  const state = entry.data as GuidanceState;
  if (!state?.revision?.id || !Array.isArray(state.transitions)) throw new Error('Invalid saved guidance state');
  return state;
}

/** Project guidance is independent of the prompt Pi cached at turn start. Strip its original injection at construction. */
export function guidancePrompt(prompt: string, sources: GuidanceSource[]) {
  return `${prompt}\n\n<optchat_guidance>\nCurrent applicable guidance, in established source order. A newer revision supersedes that source's older revision; it does not override explicit user instructions. Historical copies explain earlier work and do not become current instructions.\n${sources.map(source => `<project_instructions path="${xml(source.path)}" scope="${xml(source.scope)}">\n${source.supplied}\n</project_instructions>`).join('\n\n')}\n</optchat_guidance>`;
}

// Pi maps hidden custom context to the provider's user-compatible role, including APIs that
// collapse later system messages into the head. It never enters the canonical session or memory.
function notice(content: string): AgentMessage {
  return { role: 'custom', customType: 'optchat-guidance-update', display: false,
    content: `<guidance_update>\nHarness-supplied guidance transition, not a new user task.\n${content}\n</guidance_update>`, timestamp: 0 };
}

export interface GuidanceOptions { agentDir?: string; discover?: boolean }

export class Guidance {
  readonly archive: GuidanceArchive;
  private agentDir = getAgentDir();
  /** A custom Pi agent directory is visible in its loaded global source. */
  configure(files: readonly { path: string; content: string }[], cwd: string) {
    const ancestors = new Set<string>();
    for (let dir = resolve(cwd); ; dir = dirname(dir)) { ancestors.add(dir); if (dir === dirname(dir)) break; }
    const global = files.find(file => !ancestors.has(dirname(resolve(file.path))));
    if (global && !this.options.agentDir) this.agentDir = dirname(resolve(global.path));
  }
  constructor(readonly profile: string, private readonly options: GuidanceOptions = {}) {
    this.archive = new GuidanceArchive(profile);
    this.agentDir = options.agentDir ?? getAgentDir();
  }
  private transitionText(transition: Transition) {
    const before = this.archive.revision(transition.before), after = this.archive.revision(transition.after);
    const paths = before.files.slice(0, 3).map(file => `${file.path} → ${file.supplied}`).join('\n') || '(no previous sources)';
    const all = before.files.length > 3 ? `\nAll previous sources in order: ${join(this.archive.directory, 'revisions', `${before.id}.json`)}` : '';
    return `Project guidance has been updated directly in your context; the complete current contents are already supplied, so no manual reread is needed.\n${difference(before, after)}\nThis revision applies from this step onward; earlier work may reflect earlier instructions and may need adaptation, but a difference alone does not establish an earlier instruction violation.\nPrevious guidance (historical copies):\n${paths}${all}\nOpen a previous copy only if needed to understand something relevant to continuing the task; it does not replace current guidance.`;
  }
  prepare(messages: AgentMessage[], cwd: string, previous: GuidanceState | undefined, save: (state: GuidanceState) => void, agentDir?: string) {
    const head = getCurrentSystemMessage(messages);
    if (!head) throw new Error('Cannot inject guidance without a system prompt');
    if (previous) previous = { ...previous, revision: this.archive.revision(previous.revision.id) };
    const sources = currentGuidance(cwd, this.profile, agentDir ?? this.agentDir, this.options.discover), revision = this.archive.preserve(sources);
    let state = previous;
    if (previous?.revision.id !== revision.id) {
      const keys = new Set(messages.filter(message => message.role !== 'system').map(guidanceKey));
      const earlier = previous?.transitions.findLast(t => !keys.has(t.anchor));
      const transitions = (previous?.transitions ?? []).filter(t => keys.has(t.anchor) || t === earlier);
      if (previous && !sameEffectiveGuidance(previous.revision, revision)) {
        const work = messages.filter(message => message.role !== 'system' && !isAtWork(message));
        const last = work.at(-1), anchor = last ? guidanceKey(last) : '';
        transitions.push({ before: previous.revision.id, after: revision.id, anchor, occurrence: work.filter(message => guidanceKey(message) === anchor).length - 1 });
      }
      state = { revision, transitions };
      save(state);
    }
    const output: AgentMessage[] = [{ role: 'system', content: guidancePrompt(getSystemMessageText(head), sources), toolsAdded: head.toolsAdded, timestamp: 0 }];
    const body = messages.filter(message => message.role !== 'system');
    const keys = body.map(guidanceKey);
    // Once a boundary leaves the visible work, retain the latest such transition, explicitly as history.
    const historical = state!.transitions.findLast(transition => keys.filter(key => key === transition.anchor).length <= (transition.occurrence ?? 0));
    const occurrences = new Map<string, number>();
    for (const [index, message] of body.entries()) {
      output.push(message);
      if (index === 0 && historical) output.push(notice(`Earlier guidance transition (already applied, not a new change):\n${this.transitionText(historical)}`));
      const occurrence = occurrences.get(keys[index]) ?? 0; occurrences.set(keys[index], occurrence + 1);
      for (const transition of state!.transitions) if (transition.anchor === keys[index] && occurrence === (transition.occurrence ?? 0))
        output.push(notice(this.transitionText(transition)));
    }
    return { messages: output, revision };
  }
}
