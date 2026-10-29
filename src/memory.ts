import { Memory as CoreMemory, VIEW, type Compressor, type MemoryOptions } from './core/memory.ts';
import type { Saved, Store } from './core/store.ts';
import { FileStore, storeFor } from './store.ts';

/** A memory in a profile directory, which also holds its local files (browser page, runs, imports) whatever the store. */
export class Memory extends CoreMemory {
  readonly directory: string;
  /** Opens the memory in `directory` through the store `storeFor` picks, after its load. */
  static async open(directory: string, compress: Compressor, { warn = console.error, budget, jobs }: MemoryOptions = {}) {
    const store = storeFor(directory, warn);
    return new Memory({ directory, store, saved: await store.load() }, compress, warn, budget, jobs);
  }
  /** A directory alone opens a FileStore there. */
  constructor(source: string | { directory: string; store: Store; saved: Saved }, compress: Compressor,
    warn: (s: string) => void = console.error, budget = VIEW, jobs = 8, retryMs = 10_000) {
    const opened = typeof source === 'string' ? fileMemory(source, warn) : source;
    super(opened, compress, warn, budget, jobs, retryMs);
    this.directory = opened.directory;
  }
}

function fileMemory(directory: string, warn: (s: string) => void) {
  const store = new FileStore(directory, warn);
  return { directory, store, saved: store.load() };
}
