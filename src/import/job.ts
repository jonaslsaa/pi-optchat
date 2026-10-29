import { existsSync, readFileSync, rmSync, cpSync, mkdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Memory } from '../memory.ts';
import type { Entry, Compressor } from '../core/memory.ts';
import { deduplicate as dedupe, planImport, runImport as build, type ImportMode } from '../core/import.ts';
import { atomicWrite } from '../store.ts';
import { record } from '../core/cache.ts';
import { copyKey, type ImportedEntry } from './sources.ts';
import { DEFAULT_SETTINGS } from '../settings.ts';

export type { ImportMode };
export interface ImportJob {
  id: string; mode: ImportMode; previous: string; target: string; created: string;
  added: number; skipped: number; total: number; inputBytes: number;
}
const pendingFile = (dir: string) => join(dir, 'imports', 'pending.json');
// The whole planned log. `main/` holds only the part already given to Memory, so resume continues from its length.
const STAGED = 'staged.jsonl';
function generationPath(dir: string, name: string) {
  if (name !== '.' && !/^memories\/[a-f0-9-]{36}$/.test(name)) throw new Error('Invalid memory generation path.');
  return join(dir, name);
}
export function memoryDirectory(dir: string): string {
  const file = join(dir, 'active-memory.json');
  if (!existsSync(file)) return dir;
  const name: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (typeof name !== 'string') throw new Error('Invalid active memory pointer.');
  const path = generationPath(dir, name);
  if (!existsSync(join(path, 'main'))) throw new Error('Active memory generation is missing.');
  return path;
}
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
/** Call only while holding the profile lock, after closing its old Memory worker. */
export function prepareImport(dir: string, old: Memory, incoming: readonly ImportedEntry[], mode: ImportMode): ImportJob | undefined {
  if (pendingImport(dir)) throw new Error('Resume or discard the pending import first.');
  const plan = planImport(old.root, incoming, mode, copyKey);
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
    created: new Date().toISOString(), added: plan.added, skipped: plan.skipped, total: entries.length, inputBytes: plan.inputBytes };
  atomicWrite(pendingFile(dir), JSON.stringify(job, null, 2));
  return job;
}
export function discardImport(dir: string) {
  const job = pendingImport(dir); if (!job) return;
  if (memoryDirectory(dir) === generationPath(dir, job.target)) throw new Error('Import is already activated; it cannot be discarded.');
  // Remove the journal first: any interruption leaves only an unused staging directory.
  rmSync(pendingFile(dir)); rmSync(generationPath(dir, job.target), { recursive: true, force: true });
}
export interface ImportProgress { messages: number; total: number; summaries: number; error?: string }
export async function runImport(dir: string, compress: Compressor, signal: AbortSignal, jobs = DEFAULT_SETTINGS.jobs,
  progress: (state: ImportProgress) => void = () => {}): Promise<ImportJob> {
  const job = pendingImport(dir); if (!job) throw new Error('No pending import.');
  const path = generationPath(dir, job.target);
  const finish = () => { rmSync(join(path, STAGED), { force: true }); rmSync(pendingFile(dir)); };
  // A crash after the pointer swap leaves only the cleanup to do.
  if (memoryDirectory(dir) === path) { finish(); return job; }
  if (!existsSync(join(path, STAGED))) throw new Error('Import staging data is missing; original memory remains intact.');
  const plan: unknown[] = readFileSync(join(path, STAGED), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  let memory: Memory | undefined;
  const report = () => memory && progress({ messages: memory.root.length - memory.pending, total: plan.length, summaries: memory.tree.size, error: memory.lastError });
  const timer = setInterval(report, 500);
  try {
    await build({ plan, total: job.total, open: async () => { memory = await Memory.open(path, compress, { warn: () => {}, jobs }); report(); return memory; }, activate: () => {
      atomicWrite(join(dir, 'imports', `${job.id}.json`), JSON.stringify({ ...job, completed: new Date().toISOString() }, null, 2));
      atomicWrite(join(dir, 'active-memory.json'), JSON.stringify(job.target));
    } }, signal);
    finish(); report(); return job;
  } finally { clearInterval(timer); await memory?.close(); } // Also when `open` fails after opening: a throwing progress callback.
}
