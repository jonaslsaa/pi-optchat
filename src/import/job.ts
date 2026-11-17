import { existsSync, readFileSync, readdirSync, rmSync, cpSync, mkdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Memory, readMemory } from '../memory.ts';
import { isEntry, type Entry, type Compressor } from '../core/memory.ts';
import { deduplicate as dedupe, planImport, runImport as build, type ImportMode } from '../core/import.ts';
import { atomicWrite } from '../store.ts';
import { ACTIVE_MEMORY, generationPath, memoryDirectory, profileOwner } from '../profiles.ts';
import { record } from '../core/cache.ts';
import { copyKey, type ImportedEntry } from './sources.ts';
import { DEFAULT_SETTINGS } from '../settings.ts';

export type { ImportMode };
export interface ImportJob {
  id: string; mode: ImportMode; previous: string; target: string; created: string;
  added: number; skipped: number; total: number; inputBytes: number;
}
const pendingFile = (dir: string) => join(dir, 'imports', 'pending.json');
/** The pending import's progress as its run last wrote it, for `readImport`: its numbers, and whether it ran, paused or failed. */
const statusFile = (dir: string) => join(dir, 'imports', 'status.json');
// The whole planned log. `main/` holds only the part already given to Memory, so resume continues from its length.
const STAGED = 'staged.jsonl';
export function pendingImport(dir: string): ImportJob | undefined {
  if (!existsSync(pendingFile(dir))) return undefined;
  const j: unknown = JSON.parse(readFileSync(pendingFile(dir), 'utf8'));
  if (!record(j) || typeof j.id !== 'string' || !/^[a-f0-9-]{36}$/.test(j.id)
    || !['append', 'rebuild'].includes(String(j.mode)) || typeof j.previous !== 'string' || j.target !== `memories/${j.id}`
    || typeof j.created !== 'string' || !['added', 'skipped', 'total', 'inputBytes'].every(k => Number.isSafeInteger(j[k]) && Number(j[k]) >= 0))
    throw new Error('Invalid import journal. Refusing to change profile memory.');
  generationPath(dir, j.previous);
  return { id: j.id, mode: j.mode === 'append' ? 'append' : 'rebuild', previous: j.previous, target: `memories/${j.id}`,
    created: j.created, added: Number(j.added), skipped: Number(j.skipped), total: Number(j.total), inputBytes: Number(j.inputBytes) };
}
/** Pi also drops a Claude message copied into a forked session (`copyKey`). */
export const deduplicate = (existing: readonly Entry[], incoming: readonly ImportedEntry[]) => dedupe(existing, incoming, copyKey);
/** Call only while holding the profile lock, after closing its old Memory worker. `skipped`: duplicates already left out of `incoming`. */
export function prepareImport(dir: string, old: Memory, incoming: readonly ImportedEntry[], mode: ImportMode, skipped = 0): ImportJob | undefined {
  if (pendingImport(dir)) throw new Error('Resume or discard the pending import first.');
  const plan = planImport(old.entries(), incoming, mode, copyKey);
  if (!plan) return undefined;
  const { entries, kept } = plan, id = randomUUID(), target = `memories/${id}`, path = generationPath(dir, target);
  for (const sub of ['main', 'tree']) mkdirSync(join(path, sub), { recursive: true, mode: 0o700 });
  if (kept) atomicWrite(join(path, 'main', '000-import.jsonl'), entries.slice(0, kept).map(e => JSON.stringify(e)).join('\n') + '\n');
  atomicWrite(join(path, STAGED), entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  if (mode === 'append') {
    cpSync(join(old.directory, 'tree'), join(path, 'tree'), { recursive: true });
    // The old messages keep their ids, so their saved view (and its prompt cache) still holds.
    if (existsSync(join(old.directory, 'view.json'))) cpSync(join(old.directory, 'view.json'), join(path, 'view.json'));
  }
  const job: ImportJob = { id, mode, previous: relative(dir, old.directory).split(sep).join('/') || '.', target,
    created: new Date().toISOString(), added: plan.added, skipped: plan.skipped + skipped, total: entries.length, inputBytes: plan.inputBytes };
  atomicWrite(pendingFile(dir), JSON.stringify(job, null, 2));
  return job;
}
export function discardImport(dir: string) {
  const job = pendingImport(dir); if (!job) return;
  if (memoryDirectory(dir) === generationPath(dir, job.target)) throw new Error('Import is already activated; it cannot be discarded.');
  // Remove the journal first: any interruption leaves only an unused staging directory.
  rmSync(pendingFile(dir)); rmSync(statusFile(dir), { force: true }); rmSync(generationPath(dir, job.target), { recursive: true, force: true });
}
export interface ImportProgress { messages: number; total: number; summaries: number; error?: string }
/** `imports/status.json`. The import's mode, counts and total stay in its journal. */
type Saved = Omit<ImportProgress, 'total'> & { id: string; state: 'running' | 'paused' | 'failed'; pid: number };
const isSaved = (v: unknown): v is Saved => record(v) && typeof v.id === 'string' && (v.state === 'running' || v.state === 'paused' || v.state === 'failed')
  && ['pid', 'messages', 'summaries'].every(k => Number.isSafeInteger(v[k])) && (v.error === undefined || typeof v.error === 'string');
/** A profile's import as another app shows it: none (`idle`), or the pending one with its numbers. One running in a Pi that has since quit
 * reads `paused`, with the numbers it last wrote. Reads only; no Pi needed. */
export async function readImport(dir: string): Promise<ImportStatus> {
  const job = pendingImport(dir);
  if (!job) { const last = finished(dir); return { state: 'idle', ...last && { last } }; }
  const { mode, created, added, skipped, total } = job;
  let saved: unknown;
  try { saved = JSON.parse(readFileSync(statusFile(dir), 'utf8')); } catch { saved = undefined; }
  if (isSaved(saved) && saved.id === job.id) {
    const { messages, summaries, error } = saved;
    // Held by another kind of process (or not answering): not this run's Pi, unless it is too busy to answer, so the file stays the word.
    const owner = saved.state === 'running' ? await profileOwner(dir).catch(() => ({ pid: saved.pid })) : undefined;
    const state = saved.state === 'running' && owner?.pid !== saved.pid ? 'paused' : saved.state;
    return { state, mode, created, added, skipped, messages, total, summaries, ...error !== undefined && { error } };
  }
  // Staged by a version that wrote no status, or never run: count what its memory has built.
  const memory = await readMemory(generationPath(dir, job.target));
  return { state: 'paused', mode, created, added, skipped, messages: memory.root.length - memory.pending, total, summaries: memory.tree.size };
}
/** The latest finished import, from the record each one leaves in `imports/<id>.json` when it switches memory. */
function finished(dir: string) {
  let last: { completed: string; added: number; mode: ImportMode } | undefined;
  for (const name of existsSync(join(dir, 'imports')) ? readdirSync(join(dir, 'imports')) : []) {
    if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
    let done: unknown;
    try { done = JSON.parse(readFileSync(join(dir, 'imports', name), 'utf8')); } catch { continue; }
    if (record(done) && typeof done.completed === 'string' && Number.isSafeInteger(done.added) && (done.mode === 'append' || done.mode === 'rebuild')
      && (!last || done.completed > last.completed)) last = { completed: done.completed, added: Number(done.added), mode: done.mode };
  }
  return last;
}
export type ImportStatus = { state: 'idle'; last?: ReturnType<typeof finished> } | ({ state: Saved['state']; mode: ImportMode; created: string; added: number; skipped: number } & ImportProgress);
export async function runImport(dir: string, compress: Compressor, signal: AbortSignal, jobs = DEFAULT_SETTINGS.jobs,
  progress: (state: ImportProgress) => void = () => {}): Promise<ImportJob> {
  const job = pendingImport(dir); if (!job) throw new Error('No pending import.');
  const path = generationPath(dir, job.target);
  const finish = () => { rmSync(join(path, STAGED), { force: true }); rmSync(pendingFile(dir)); rmSync(statusFile(dir), { force: true }); };
  // A crash after the pointer swap leaves only the cleanup to do.
  if (memoryDirectory(dir) === path) { finish(); return job; }
  let memory: Memory | undefined, last: ImportProgress = { messages: 0, total: job.total, summaries: 0 }, timer: NodeJS.Timeout | undefined;
  const save = (state: Saved['state'], { messages, summaries, error }: ImportProgress = last) => {
    atomicWrite(statusFile(dir), JSON.stringify({ id: job.id, state, pid: process.pid, messages, summaries, ...error !== undefined && { error } } satisfies Saved));
  };
  const report = () => {
    if (!memory) return;
    const now = { messages: memory.root.length - memory.pending, total: job.total, summaries: memory.tree.size, error: memory.lastError };
    // From the timer too, where a throw would take Pi down: a status that can't be written now is written at the next change.
    if (JSON.stringify(now) !== JSON.stringify(last)) { try { save('running', now); last = now; } catch {} }
    progress(now);
  };
  try {
    save('running');
    if (!existsSync(join(path, STAGED))) throw new Error('Import staging data is missing; original memory remains intact.');
    const plan: unknown[] = readFileSync(join(path, STAGED), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
    // Every line must parse, and the plan must be whole and in order, so a damaged plan is refused before anything is written.
    if (!plan.every(isEntry) || plan.length !== job.total || plan.some((e, i) => e.i !== i)) throw new Error('Import staging data is invalid; original memory remains intact.');
    timer = setInterval(report, 500);
    await build({ entry: i => plan[i], total: job.total, open: async () => { memory = await Memory.open(path, compress, { warn: () => {}, jobs }); report(); return memory; }, activate: () => {
      atomicWrite(join(dir, 'imports', `${job.id}.json`), JSON.stringify({ ...job, completed: new Date().toISOString() }, null, 2));
      atomicWrite(join(dir, ACTIVE_MEMORY), JSON.stringify(job.target));
    } }, signal);
    report(); finish(); return job;
  } catch (error) {
    // Paused (or Pi stopping) keeps the last error, the retry it was waiting on; a failure says what stopped it, for an app to show.
    try { if (existsSync(pendingFile(dir))) save(signal.aborted ? 'paused' : 'failed', signal.aborted ? last : { ...last, error: error instanceof Error ? error.message : String(error) }); } catch {}
    throw error;
  } finally { clearInterval(timer); await memory?.close(); } // Also when `open` fails after opening: a throwing progress callback.
}
