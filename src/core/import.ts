import { bytes, isEntry, type Entry, type Memory } from './memory.ts';

/** What planning reads of a message: no text, so a host can plan from metadata alone. */
type Meta = Pick<Entry, 'kind' | 'date' | 'receipt' | 'origin'>;

/** Append keeps the existing log and its summaries and adds the new messages after them; rebuild orders everything by date and
 * summarizes it all again. Either way the host builds the result on a staging store and switches to it only once it is complete. */
export type ImportMode = 'append' | 'rebuild';
/** A message to import, before memory numbers it. Its `receipt` starts with `import:` and is stable per source message, so
 * importing the same history again adds nothing. */
export type ImportedEntry = Omit<Entry, 'i'>;

/** Drops what memory already has: the same receipt, or the same `copyOf` key, the host's second identity for one message
 * (Pi: a Claude message copied into a forked session). */
export function deduplicate<E extends Meta>(existing: readonly E[], incoming: readonly ImportedEntry[],
  copyOf: (entry: E | ImportedEntry) => string | undefined = () => undefined) {
  const receipts = new Set(existing.map(e => e.receipt).filter(Boolean));
  const copies = new Set(existing.map(copyOf).filter(Boolean));
  const added: ImportedEntry[] = []; let skipped = 0;
  for (const entry of incoming) {
    if (!entry.receipt?.startsWith('import:')) throw new Error('Imported entry has no stable source identity.');
    const copy = copyOf(entry);
    if (receipts.has(entry.receipt) || copy && copies.has(copy)) { skipped++; continue; }
    receipts.add(entry.receipt); if (copy) copies.add(copy); added.push(entry);
  }
  return { added, skipped };
}

/** Imported conversations remain contiguous; existing native history is grouped by user turn. An imported message without an
 * origin stands alone: in a native turn it would move that turn, and a host's cursor in the log with it. */
export function chronological<E extends Meta>(entries: readonly E[]) {
  const groups = new Map<string, { date: string; entries: E[] }>();
  let native = 0;
  for (const entry of entries) {
    const imported = entry.receipt?.startsWith('import:') ? entry.receipt : undefined;
    if (!entry.origin && !imported && entry.kind === 'user') native++;
    const id = entry.origin ? JSON.stringify([entry.origin.source, entry.origin.conversation]) : imported ?? `native:${native}`;
    const group = groups.get(id) ?? { date: entry.date, entries: [] };
    group.date = group.date < entry.date ? group.date : entry.date;
    group.entries.push(entry); groups.set(id, group);
  }
  return [...groups.values()].sort((a, b) => a.date.localeCompare(b.date)).flatMap(g => g.entries);
}

/** The whole log an import builds, or undefined when nothing is new. Its first `kept` entries are the existing log as it is (append),
 * so the host seeds the staging store with them and the existing summaries and view; rebuild keeps none. */
export function planImport(existing: readonly Entry[], incoming: readonly ImportedEntry[], mode: ImportMode,
  copyOf?: (entry: ImportedEntry) => string | undefined) {
  const { added, skipped } = deduplicate(existing, incoming, copyOf);
  if (!added.length) return undefined;
  const all = mode === 'rebuild' ? chronological([...existing, ...added]) : [...existing, ...chronological(added)];
  const entries: Entry[] = all.map((e, i) => ({ ...e, i }));
  return { mode, entries, kept: mode === 'append' ? existing.length : 0, added: added.length, skipped,
    inputBytes: (mode === 'rebuild' ? entries : added).reduce((n, e) => n + bytes(e.text), 0) };
}

/** Builds the staging memory `open` gives from the plan, `entry(i)` for each of its `total` messages, and calls `activate` once its
 * whole tree is built and it is closed. It continues from what the memory already logged, so a paused or crashed import resumes. A
 * planned message that isn't a valid entry at its index, or a memory that isn't a start of the plan, stops it before the switch;
 * `entry` is read as needed, so a host need not hold the plan in RAM.
 * The live memory must take no messages from `planImport` until `activate`, or the switch drops them: queue them and log them after. */
export async function runImport({ entry, total, open, activate }: { entry: (i: number) => unknown; total: number;
  open: () => Promise<Memory>; activate: () => void | Promise<void> }, signal: AbortSignal) {
  const planned = (i: number) => {
    const e = entry(i);
    if (!isEntry(e) || e.i !== i) throw new Error('Import staging data is invalid; original memory remains intact.');
    return e;
  };
  if (!Number.isSafeInteger(total) || total < 0) throw new Error('Import staging data is invalid; original memory remains intact.');
  const memory = await open();
  try {
    if (memory.root.length > total || memory.root.some((_, i) => memory.text(i) !== planned(i).text)) throw new Error('Import staging data does not match its log; original memory remains intact.');
    // Recipe §10: imported messages are compressed like any other. Each is logged once its node can start, as a burst of live
    // messages is, so up to `jobs` summaries run at once. Unlike a turn, an import waits through failures (`lastError` says why).
    for (let i = memory.root.length; i < total; i++) { await memory.settle(signal, 'ahead'); const e = planned(i); memory.append(e.kind, e.text, e.date, e.receipt, e.origin); }
    await memory.settle(signal, 'tree'); signal.throwIfAborted();
    // Close all writers before the switch. The previous memory stays intact.
    await memory.close();
    // A store that writes behind reports a failed write only here: switching would drop the messages it lost.
    if (memory.saveError !== undefined) throw new Error(`Import could not be saved: ${memory.saveError}; original memory remains intact.`);
    signal.throwIfAborted();
    await activate();
  } finally { await memory.close(); }
}
