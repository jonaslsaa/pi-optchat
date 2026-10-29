import type { Entry, Summary } from './memory.ts';

/** The image types memory keeps, and the file extension each is saved under. */
export const EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' } as const;
export type Mime = keyof typeof EXTENSIONS;
export const isMime = (mime: string): mime is Mime => Object.hasOwn(EXTENSIONS, mime);

/** What a store gives back when a memory opens. Memory validates every record itself; `view` is the JSON `saveView` was last given. */
export interface Saved { entries: unknown[]; tree: unknown[]; view?: string }
/** A write is done when it returns: a store that writes behind returns a promise instead, which Memory awaits in order. */
type Write = Promise<void> | undefined;
type Maybe<T> = T | Promise<T>;

/** Cross-machine exclusivity. Implement it only if you want it: without it Pi's OptChat keeps its machine-local lock (a socket in
 * the profile, or a named pipe on Windows), so two Pis on one machine still can't share a profile. */
export interface Lease {
  /** Takes the profile for `holder` (who and where, shown to anyone refused), or returns the current holder.
   * A lease not renewed for about 30 seconds may be taken by someone else. */
  lease(profile: string, holder: string): Promise<string | undefined>;
  /** Renews the lease. OptChat calls it every 10 seconds while it holds the profile and only warns when it fails, so fencing is
   * the store's job: once its lease may have lapsed, it must refuse writes (for example with a fencing token checked on each one),
   * since a paused process cannot be trusted to stop itself in time. */
  heartbeat(): Promise<void>;
  release(): Promise<void>;
}

/** Where one memory keeps what travels between machines: its message log, summary nodes, saved view and images. Everything else
 * in a Pi profile (runs, recovery journals, the active-memory pointer and imports, usage, settings, AGENTS.md) stays on the machine.
 * Memory loads once when it opens, then works in RAM and issues every write in order. */
export interface Store {
  load(): Maybe<Saved>;
  /** Appends a message. Throws, writing nothing, if someone else appended since this store loaded. */
  append(entry: Entry): Write;
  /** Appends a summary node. */
  appendNode(node: Summary): Write;
  /** Replaces the saved view. */
  saveView(view: string): Write;
  putImage(name: string, mimeType: Mime, data: Uint8Array): Write;
  image(name: string): Maybe<{ mimeType: Mime; data: Uint8Array } | undefined>;
  lock?: Lease;
}
