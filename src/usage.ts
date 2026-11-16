import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { appendJson } from './store.ts';
import { loadUsage, selectUsage, usageFile, usageWarnings, validEntry, type UsageEntry, type UsageRange } from './usage-record.ts';
export { emptyUsage, ranges, summarizeUsage, type UsageEntry, type UsageRange, type UsageRole } from './usage-record.ts';

/** One profile's ledger. Stable message IDs make resume/backfill idempotent. */
export class UsageLedger {
  readonly entries: UsageEntry[];
  private invalid: number;
  private readonly ids: Set<string>;
  private readonly cursors = new Map<string, number>();
  private readonly file: string;
  constructor(directory: string) {
    this.file = usageFile(directory);
    const { entries, ids, invalid, torn } = loadUsage(directory, true);
    this.entries = entries; this.ids = ids; this.invalid = invalid;
    if (torn) appendFileSync(this.file, '\n');
  }
  get warnings() { return usageWarnings(this.invalid); }
  add(entry: UsageEntry) {
    if (!validEntry(entry)) { this.invalid++; return; }
    if (entry.id && this.ids.has(entry.id)) return;
    appendJson(this.file, entry);
    this.entries.push(entry); if (entry.id) this.ids.add(entry.id);
  }
  compression(message: AssistantMessage, role: 'compactor' | 'import', session: string) {
    this.add({ id: randomUUID(), date: new Date().toISOString(), role, session, provider: message.provider, model: message.model, usage: message.usage });
  }
  backfill(entries: SessionEntry[], session: string, role: 'main' | 'subagent' = 'main', runId?: string) {
    const cursorKey = `${session}:${runId ?? ''}`;
    const cursor = this.cursors.get(cursorKey) ?? 0;
    for (const entry of entries.slice(cursor <= entries.length ? cursor : 0)) {
      // Pi forks preserve entry IDs/timestamps. Never count inherited responses twice.
      const id = `entry:${entry.id}:${entry.timestamp}`;
      if (entry.type === 'message') {
        const message = entry.message;
        if ((message.role === 'assistant' || message.role === 'toolResult') && message.usage) this.add({ id,
          date: new Date(message.timestamp).toISOString(), role, session, runId,
          provider: message.role === 'assistant' ? message.provider : undefined,
          model: message.role === 'assistant' ? message.model : 'tool usage (model unavailable)', usage: message.usage });
      }
      else if ((entry.type === 'usage' || entry.type === 'compaction' || entry.type === 'branch_summary') && entry.usage) {
        this.add({ id, date: entry.timestamp, role, session, runId, model: 'session overhead', usage: entry.usage });
      }
    }
    this.cursors.set(cursorKey, entries.length);
  }
  select(range: UsageRange, session: string, now = Date.now()) { return selectUsage(this.entries, range, now, session); }
}
