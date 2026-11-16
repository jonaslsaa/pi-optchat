import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { record } from './core/cache.ts';

/** What a profile's usage ledger (`usage.jsonl`) holds and how it is read, chosen from and summed, with nothing from Pi: the Pi
 * that owns a profile writes it through `UsageLedger`, and another app reads it with `readUsage` while that Pi runs. */
export type UsageRole = 'main' | 'subagent' | 'compactor' | 'import';
export const ranges = ['This session', 'Last hour', 'Today', 'Last 7 days', 'All time'] as const;
export type UsageRange = typeof ranges[number];
export function emptyUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}
/** The tokens and dollars the ledger keeps of a response: the numbers of pi-ai's `Usage`. */
export type UsageTotals = ReturnType<typeof emptyUsage>;
export interface UsageEntry {
  id?: string; date: string; role: UsageRole; model: string; provider?: string;
  session?: string; runId?: string; usage: UsageTotals;
}
const nonnegative = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
function validUsage(value: unknown): value is UsageTotals {
  if (!record(value) || !record(value.cost)) return false;
  const cost = value.cost;
  return ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'].every(k => nonnegative(value[k]))
    && ['input', 'output', 'cacheRead', 'cacheWrite', 'total'].every(k => nonnegative(cost[k]));
}
export function validEntry(value: unknown): value is UsageEntry {
  return record(value) && typeof value.date === 'string' && Number.isFinite(Date.parse(value.date))
    && ['main', 'subagent', 'compactor', 'import'].includes(String(value.role)) && typeof value.model === 'string'
    && ['id', 'provider', 'session', 'runId'].every(k => value[k] === undefined || typeof value[k] === 'string') && validUsage(value.usage);
}
function addUsage(total: UsageTotals, usage: UsageTotals) {
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'] as const) total[key] += usage[key];
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'total'] as const) total.cost[key] += usage.cost[key];
}
/** How much of what a model was sent it read from the cache, as a whole percent: the "cached" of `/optchat usage`. */
export function cacheShare(usage: UsageTotals) {
  const sent = usage.input + usage.cacheRead + usage.cacheWrite;
  return sent ? Math.round(100 * usage.cacheRead / sent) : 0;
}
export const usageFile = (directory: string) => join(directory, 'usage.jsonl');

/** The ledger's records as they are on disk, each id once, and how many lines can't be read. Text after the last line feed is
 * the owner's last record when the owner reads what it left behind (`whole`), and one it is still writing to anyone else. */
export function loadUsage(directory: string, whole: boolean) {
  const file = usageFile(directory), lines = (existsSync(file) ? readFileSync(file, 'utf8') : '').split('\n'), torn = lines.pop();
  const entries: UsageEntry[] = [], ids = new Set<string>();
  let invalid = 0;
  for (const line of whole && torn ? [...lines, torn] : lines) {
    if (!line.trim()) continue;
    try {
      const entry: unknown = JSON.parse(line);
      if (!validEntry(entry)) { invalid++; continue; }
      if (entry.id && ids.has(entry.id)) continue;
      entries.push(entry); if (entry.id) ids.add(entry.id);
    } catch { invalid++; }
  }
  return { entries, ids, invalid, torn: Boolean(torn) };
}
export const usageWarnings = (invalid: number) => invalid ? [`${invalid} unreadable usage records excluded; totals may be incomplete.`] : [];
/** A profile's ledger for a reader that is not its owner, such as an app beside a running Pi: nothing is written, and a record
 * the owner is halfway through writing is left out without a warning. */
export function readUsage(directory: string) {
  const { entries, invalid } = loadUsage(directory, false);
  return { entries, warnings: usageWarnings(invalid) };
}
/** The records of `range` as of `now`: `Today` is since local midnight, and `This session` those of Pi session `session`, which
 * are none when no session is named: a record from before sessions were kept belongs to no session. */
export function selectUsage(entries: UsageEntry[], range: UsageRange, now = Date.now(), session?: string) {
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const since = range === 'Last hour' ? now - 3600_000 : range === 'Today' ? today.getTime() : range === 'Last 7 days' ? now - 7 * 86400_000 : 0;
  return entries.filter(e => range === 'This session' ? session !== undefined && e.session === session : range === 'All time' || (Date.parse(e.date) >= since && Date.parse(e.date) <= now));
}
export function summarizeUsage(entries: UsageEntry[]) {
  const total = emptyUsage(), groups = new Map<string, { role: UsageRole; model: string; usage: UsageTotals }>();
  for (const entry of entries) {
    // By model name alone: older compactor records lack a provider and must still land in the same row.
    const key = `${entry.role}:${entry.model}`;
    let group = groups.get(key);
    if (!group) { group = { role: entry.role, model: entry.model, usage: emptyUsage() }; groups.set(key, group); }
    addUsage(group.usage, entry.usage); addUsage(total, entry.usage);
  }
  return { total, groups: [...groups.values()] };
}
