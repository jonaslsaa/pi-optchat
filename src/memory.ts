import { Memory as CoreMemory, VIEW, type Compressor, type MemoryOptions } from './core/memory.ts';
import type { Saved, Store } from './core/store.ts';
import { FileReader, FileStore, storeFor } from './store.ts';

/** A memory in a profile directory, which also holds its local files (browser page, runs, imports) whatever the store. */
export class Memory extends CoreMemory {
  readonly directory: string;
  /** Opens the memory in `directory` through the store `storeFor` picks, after its load. */
  static async open(directory: string, compress: Compressor, { warn = console.error, budget, jobs, retryMs }: MemoryOptions = {}) {
    const store = storeFor(directory, warn);
    return new Memory({ directory, store, saved: await store.load() }, compress, warn, budget, jobs, retryMs);
  }
  /** A directory alone opens a FileStore there. */
  constructor(source: string | { directory: string; store: Store; saved: Saved }, compress: Compressor,
    warn: (s: string) => void = console.error, budget = VIEW, jobs = 8, retryMs = 10_000) {
    const opened = typeof source === 'string' ? fileMemory(source, warn) : source;
    super(opened, compress, warn, budget, jobs, retryMs);
    this.directory = opened.directory;
  }
}

/** The memory in `directory` as its files are now, for a process that must not change them, such as a connected window or another
 * app: it creates nothing, writes nothing, summarizes nothing and takes no lock, so the owning Pi may keep writing meanwhile. A
 * directory that doesn't exist reads as an empty memory. */
export async function readMemory(directory: string) {
  const store = new FileReader(directory, () => {});
  const memory = new Memory({ directory, store, saved: store.load() }, () => Promise.reject(new Error('This memory is read-only.')), () => {});
  await memory.close(); // Before its first summary is scheduled.
  return memory;
}

function fileMemory(directory: string, warn: (s: string) => void) {
  const store = new FileStore(directory, warn);
  return { directory, store, saved: store.load() };
}
