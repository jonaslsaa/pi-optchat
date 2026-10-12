import { createHash } from 'node:crypto';
import type { Api, Model, ProviderHeaders } from '@earendil-works/pi-ai';
import { record } from './cache.ts';

const LIFE = 4 * 60_000; // Short cache is five minutes from request start; leave one minute of margin.
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Account and routing credentials are hashed, never stored as map keys or printed. */
export interface CacheRoute { provider: string; model: string; baseUrl: string; apiKey?: string; headers?: ProviderHeaders; env?: Record<string, string> }
export const cacheRoute = (model: Model<Api>, auth: { apiKey?: string; baseUrl?: string; headers?: ProviderHeaders; env?: Record<string, string> }, headers?: ProviderHeaders): CacheRoute =>
  ({ provider: model.provider, model: model.id, baseUrl: auth.baseUrl ?? model.baseUrl, apiKey: auth.apiKey,
    headers: { ...model.headers, ...auth.headers, ...headers }, env: auth.env });
function domain(route: CacheRoute) {
  const headers = Object.fromEntries(Object.entries(route.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v] as const)
    .filter(([k]) => !/^(user-agent|traceparent|tracestate|x-session-id|x-session-affinity|x-client-request-id|x-stainless-.*)$/.test(k)).sort(([a], [b]) => a.localeCompare(b)));
  return hash({ ...route, headers });
}
/** Official model thresholds, checked 2026-10-12. Unknown aliases/proxies are not assumed cache eligible.
 * https://platform.claude.com/docs/en/build-with-claude/prompt-caching#cache-limitations */
export function cacheMinimum(model: string): number | undefined {
  const matches = (names: string) => new RegExp(`^claude-(?:${names})(?:-20\\d{6}|-latest)?$`).test(model);
  if (matches('(?:opus|sonnet|haiku)-5-5|(?:fable|mythos)-5(?:-1)?|opus-5')) return 512;
  if (matches('mythos-preview|opus-4-7')) return 2048;
  if (matches('opus-4-[56]|haiku-4-5')) return 4096;
  if (matches('opus-4(?:-[18])?|sonnet-(?:5|4(?:-[56])?)')) return 1024;
  if (matches('3-5-haiku')) return 2048;
  return undefined;
}
const withoutMarks = (value: unknown): unknown => Array.isArray(value) ? value.map(withoutMarks) : record(value)
  ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'cache_control').map(([key, v]) => [key, withoutMarks(v)])) : value;
export interface CacheBoundary { key: string; body: Record<string, unknown> }
export interface CachePlan { writes: CacheBoundary[]; reads: Set<string> }
/** Hash each native block boundary, including role framing, tools/system and cache-affecting request settings.
 * Reads inspect only the 20 positions behind actual marks. A run of tool uses/results counts as one position. */
export function cachePlan(payload: unknown, route: CacheRoute): CachePlan {
  const empty = { writes: [], reads: new Set<string>() };
  if (!record(payload) || !Array.isArray(payload.messages)) return empty;
  const clean = withoutMarks(payload) as Record<string, unknown>;
  const { messages: _messages, max_tokens: _max, stream: _stream, temperature: _temp, top_p: _p, top_k: _k, ...settings } = clean;
  const digest = createHash('sha256').update(domain(route)).update(JSON.stringify(settings));
  const messages: (Record<string, unknown> & { content: unknown[] })[] = [];
  const boundaries: { key: string; group: number; marked: boolean; message: number; block: number }[] = [];
  let group = -1, previousType: unknown, previousRole: unknown;
  for (const message of payload.messages) {
    if (!record(message)) return empty;
    const { content: _content, ...head } = withoutMarks(message) as Record<string, unknown>;
    digest.update(JSON.stringify(head));
    const copy = { ...head, content: [] as unknown[] }; messages.push(copy);
    const content = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content;
    if (!Array.isArray(content)) return empty;
    for (const block of content) {
      if (!record(block)) return empty;
      const cleanBlock = withoutMarks(block); copy.content.push(cleanBlock);
      digest.update(JSON.stringify(cleanBlock));
      if (!((block.type === 'tool_use' || block.type === 'tool_result') && block.type === previousType && message.role === previousRole)) group++;
      previousType = block.type; previousRole = message.role;
      boundaries.push({ key: digest.copy().digest('hex'), group, marked: record(block.cache_control) && block.cache_control.type === 'ephemeral',
        message: messages.length - 1, block: copy.content.length - 1 });
    }
  }
  if (record(payload.cache_control) && payload.cache_control.type === 'ephemeral' && boundaries.length) boundaries.at(-1)!.marked = true;
  const reads = new Set<string>(), writes: CacheBoundary[] = [];
  for (let i = 0; i < boundaries.length; i++) {
    const boundary = boundaries[i];
    if (!boundary.marked) continue;
    const last = messages[boundary.message];
    writes.push({ key: boundary.key, body: { ...settings, messages: [...messages.slice(0, boundary.message), { ...last, content: last.content.slice(0, boundary.block + 1) }] } });
    for (let j = i; j >= 0 && boundary.group - boundaries[j].group < 20; j--) reads.add(boundaries[j].key);
  }
  return { writes, reads };
}

/** Ask the same provider to count a potentially shared prefix only when another request would wait on it.
 * Unsupported counting, unknown models or timeouts skip coordination; never infer tokens from bytes. */
export async function cacheEligible(boundary: CacheBoundary, route: CacheRoute, signal: AbortSignal): Promise<boolean> {
  const minimum = cacheMinimum(route.model);
  if (minimum === undefined) return false;
  const headers = new Headers({ 'content-type': 'application/json', 'anthropic-version': '2023-06-01' });
  if (route.apiKey) headers.set(route.apiKey.includes('sk-ant-oat') ? 'authorization' : 'x-api-key', route.apiKey.includes('sk-ant-oat') ? `Bearer ${route.apiKey}` : route.apiKey);
  for (const [name, value] of Object.entries(route.headers ?? {})) value === null ? headers.delete(name) : headers.set(name, value);
  const { model, tools, system, messages, thinking, tool_choice, output_config, betas } = boundary.body;
  if (Array.isArray(betas)) headers.set('anthropic-beta', betas.join(','));
  try {
    const response = await fetch(`${route.baseUrl.replace(/\/$/, '')}/v1/messages/count_tokens`, { method: 'POST', headers,
      body: JSON.stringify({ model, tools, system, messages, thinking, tool_choice, output_config }), signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]) });
    if (!response.ok) { await response.body?.cancel(); return false; }
    const result: unknown = await response.json();
    return record(result) && typeof result.input_tokens === 'number' && result.input_tokens >= minimum;
  } catch { signal.throwIfAborted(); return false; }
}

interface Pending { started: number; done: Promise<void>; finish: () => void; boundary: CacheBoundary }
export type CacheRelease = (ok: boolean) => void;
/** Process-wide so main turns and separate compressor/import instances coordinate in the same domain. */
export class CacheGate {
  private pending = new Map<string, Pending>();
  private warm = new Map<string, number>();
  private eligibility = new Map<string, { at: number; eligible: boolean }>();
  constructor(private readonly eligible = cacheEligible, private readonly life = LIFE, private readonly now = Date.now) {}
  async acquire(plan: CachePlan, route: CacheRoute, signal: AbortSignal): Promise<CacheRelease> {
    for (;;) {
      signal.throwIfAborted(); this.prune();
      const matches = [...this.pending.entries()].filter(([key]) => plan.reads.has(key));
      let waited = false;
      for (const [key, leader] of matches.reverse()) {
        const known = this.eligibility.get(key);
        const eligible = known?.eligible ?? await this.eligible(leader.boundary, route, signal);
        signal.throwIfAborted();
        this.eligibility.set(key, { at: this.now(), eligible });
        if (!eligible || this.pending.get(key) !== leader) continue;
        await this.wait(leader, signal); waited = true; break;
      }
      if (waited) continue;
      // No await between registration and return: the next arrival sees every mark we can write.
      const owned: [string, Pending][] = [], started = this.now();
      for (const boundary of plan.writes) {
        if (this.pending.has(boundary.key) || this.warm.has(boundary.key)) continue;
        let finish = () => {};
        const done = new Promise<void>(resolve => { finish = resolve; });
        const state = { started, done, finish, boundary };
        this.pending.set(boundary.key, state); owned.push([boundary.key, state]);
      }
      let released = false;
      const release: CacheRelease = ok => {
        if (released) return; released = true; signal.removeEventListener('abort', aborted);
        for (const [key, state] of owned) {
          if (this.pending.get(key) === state) this.pending.delete(key);
          state.finish();
        }
        // Only the request's own marked writes are known to refresh. A possible
        // lookback read is not evidence that the provider actually read that entry.
        if (ok && this.now() - started < this.life) for (const { key } of plan.writes)
          this.warm.set(key, Math.max(started, this.warm.get(key) ?? started));
      };
      const aborted = () => release(false);
      signal.addEventListener('abort', aborted, { once: true });
      return release;
    }
  }
  private prune() {
    const now = this.now();
    for (const [key, state] of this.pending) if (now - state.started >= this.life) { this.pending.delete(key); state.finish(); }
    for (const [key, at] of this.warm) if (now - at >= this.life) this.warm.delete(key);
    for (const [key, state] of this.eligibility) if (now - state.at >= this.life) this.eligibility.delete(key);
    while (this.warm.size > 2048) this.warm.delete(this.warm.keys().next().value!);
    while (this.eligibility.size > 2048) this.eligibility.delete(this.eligibility.keys().next().value!);
  }
  private async wait(leader: Pending, signal: AbortSignal) {
    let abort = () => {}, timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([leader.done, new Promise<void>((resolve, reject) => {
        abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true });
        timer = setTimeout(resolve, Math.max(1, this.life - (this.now() - leader.started))); timer.unref();
      })]);
      signal.throwIfAborted();
    } finally { signal.removeEventListener('abort', abort); clearTimeout(timer); }
  }
}
export const cacheGate = new CacheGate();
