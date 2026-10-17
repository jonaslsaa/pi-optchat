import { createHash } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync, readSync, lstatSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { getCurrentSystemMessage, getSystemMessageText } from '@earendil-works/pi-ai';
import { getAgentDir, loadProjectContextFiles, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { atomicWrite } from './store.ts';

export const GUIDANCE_STATE = 'optchat.guidance';
const LIMIT = 1_000_000;
const CANDIDATES = ['AGENTS.override.md', 'AGENTS.md', 'AGENTS.MD', 'CLAUDE.md', 'CLAUDE.MD'];
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const normalize = (text: string) => text.replace(/^\uFEFF/, '');
const xml = (text: string) => text.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
export interface GuidanceSource { path: string; scope: string; content: string; supplied: string; modified: string }
export interface GuidanceFile { path: string; scope: string; version: string; archive: string; supplied: string }
export interface GuidanceRevision { id: string; files: GuidanceFile[] }
interface Transition { before: string; after: string; anchor: string; text: string }
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
export function currentGuidance(cwd: string, profile: string, agentDir = getAgentDir()): GuidanceSource[] {
  const dirs = new Set([resolve(agentDir)]);
  for (let dir = resolve(cwd); ; dir = dirname(dir)) { dirs.add(dir); if (dirname(dir) === dir) break; }
  const checked = new Map<string, GuidanceSource>();
  for (const dir of dirs) {
    for (const name of CANDIDATES) {
      const source = readSource(join(dir, name), dir === resolve(agentDir) ? 'global' : `project:${dir}`);
      if (source) { checked.set(source.path, source); break; }
    }
  }
  const files = loadProjectContextFiles({ cwd, agentDir }).map(file => {
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
      const label = source.path.replace(/[^a-zA-Z0-9._-]+/g, '%').slice(-100);
      const dir = join(this.directory, 'sources', `${label}-${hash(source.path).slice(0, 16)}`, version);
      const archive = join(dir, basename(source.path));
      const supplied = source.content === source.supplied ? archive : join(dir, 'supplied.txt');
      const keep = (path: string, text: string) => {
        if (existsSync(path)) { if (readFileSync(path, 'utf8') !== text) throw new Error(`Damaged guidance archive: ${path}`); }
        else atomicWrite(path, text);
      };
      keep(archive, source.content);
      if (supplied !== archive) keep(supplied, source.supplied);
      const metadata = join(dir, 'metadata.json');
      if (!existsSync(metadata)) atomicWrite(metadata, JSON.stringify({ source: source.path, version, modified: source.modified,
        captured: new Date().toISOString(), transformation: supplied === archive ? 'none' : 'leading UTF-8 BOM removed', supplied: basename(supplied) }, null, 2));
      return { path: source.path, scope: source.scope, version, archive, supplied };
    });
    const id = hash(JSON.stringify(files));
    const file = join(this.directory, 'revisions', `${id}.json`), text = JSON.stringify({ id, files }, null, 2);
    if (existsSync(file)) { if (readFileSync(file, 'utf8') !== text) throw new Error(`Damaged guidance revision: ${file}`); }
    else atomicWrite(file, text);
    return { id, files };
  }
  revision(id: string): GuidanceRevision {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid guidance revision');
    const revision = JSON.parse(readFileSync(join(this.directory, 'revisions', `${id}.json`), 'utf8')) as GuidanceRevision;
    if (revision.id !== id || hash(JSON.stringify(revision.files)) !== id) throw new Error(`Damaged guidance revision: ${id}`);
    return revision;
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
  return `${changes.join('; ')}.`;
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

export class Guidance {
  readonly archive: GuidanceArchive;
  private agentDir = getAgentDir();
  /** A custom Pi agent directory is visible in its loaded global source. */
  configure(files: readonly { path: string; content: string }[], cwd: string) {
    const ancestors = new Set<string>();
    for (let dir = resolve(cwd); ; dir = dirname(dir)) { ancestors.add(dir); if (dir === dirname(dir)) break; }
    const global = files.find(file => !ancestors.has(dirname(resolve(file.path))));
    if (global) this.agentDir = dirname(resolve(global.path));
  }
  constructor(readonly profile: string) { this.archive = new GuidanceArchive(profile); }
  prepare(messages: AgentMessage[], cwd: string, previous: GuidanceState | undefined, save: (state: GuidanceState) => void, agentDir?: string) {
    const sources = currentGuidance(cwd, this.profile, agentDir ?? this.agentDir), revision = this.archive.preserve(sources);
    let state = previous;
    if (previous?.revision.id !== revision.id) {
      const transitions = [...previous?.transitions ?? []];
      if (previous) {
        const before = this.archive.revision(previous.revision.id);
        const paths = before.files.map(file => `${file.path} → ${file.supplied}`).join('\n') || '(no previous sources)';
        const text = `Project guidance has been updated directly in your context; the complete current contents are already supplied, so no manual reread is needed.\n${difference(before, revision)}\nThis revision applies from this step onward; earlier work may reflect earlier instructions and may need adaptation, but a difference alone does not establish an earlier instruction violation.\nPrevious guidance (historical copies):\n${paths}\nOpen a previous copy only if needed to understand something relevant to continuing the task; it does not replace current guidance.`;
        const last = messages.findLast(message => message.role !== 'system');
        transitions.push({ before: before.id, after: revision.id, anchor: last ? guidanceKey(last) : '', text });
      }
      state = { revision, transitions };
      save(state);
    }
    const head = getCurrentSystemMessage(messages);
    if (!head) throw new Error('Cannot inject guidance without a system prompt');
    const output: AgentMessage[] = [{ role: 'system', content: guidancePrompt(getSystemMessageText(head), sources), toolsAdded: head.toolsAdded, timestamp: 0 }];
    const body = messages.filter(message => message.role !== 'system');
    const keys = body.map(guidanceKey);
    // Once a boundary leaves the visible work, retain the latest such transition, explicitly as history.
    const historical = state!.transitions.findLast(transition => !keys.includes(transition.anchor));
    for (const [index, message] of body.entries()) {
      output.push(message);
      if (index === 0 && historical) output.push(notice(`Earlier guidance transition (already applied, not a new change):\n${historical.text}`));
      for (const transition of state!.transitions) if (transition.anchor === keys[index])
        output.push(notice(transition.text));
    }
    return { messages: output, revision };
  }
}
