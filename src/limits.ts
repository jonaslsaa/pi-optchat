import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { record } from './core/cache.ts';
import { atomicWrite } from './store.ts';

/** The windows a subscription's use is counted in, as the provider names them: five hours and seven days. */
export const LIMIT_WINDOWS = ['5h', '7d'] as const;
/** One limit as the provider last counted it: the share of it that is used (1 is all of it; it can be more), when the window
 * starts again, and whether it is `reached`, which is when the provider refuses requests on it. */
export interface Limit { window: typeof LIMIT_WINDOWS[number]; used: number; resets: string; reached: boolean }
/** A subscription's limits as of the provider's latest answer (`at`): the windows it counted, and whether requests past a
 * reached limit are let through and billed as extra usage (`overage`). `refused` is when a request was last turned away for
 * a rate limit since; the provider says nothing more with that, so the windows are then from before it. Dates are ISO. */
export interface Limits { at: string; limits: Limit[]; overage: boolean; refused?: string }

const file = (directory: string) => join(directory, 'limits.json');
const header = (window: string, name: string) => `anthropic-ratelimit-unified-${window}${name}`;
const date = (value: unknown) => typeof value === 'string' && !Number.isNaN(Date.parse(value));
const valid = (value: unknown): value is Limits => record(value) && date(value.at) && typeof value.overage === 'boolean' && (value.refused === undefined || date(value.refused))
  && Array.isArray(value.limits) && value.limits.every((limit: unknown) => record(limit) && LIMIT_WINDOWS.some(window => window === limit.window)
    && typeof limit.used === 'number' && limit.used >= 0 && date(limit.resets) && typeof limit.reached === 'boolean');

/** What a provider's response headers say of the subscription's limits, or nothing where they say none. Anthropic sends them
 * to a subscription's login with every answer (`anthropic-ratelimit-unified-…`: a window's use as a fraction, its reset in
 * seconds since 1970, its status); an API key gets none, and neither does any other provider through Pi. */
export function limitsFrom(headers: Record<string, string>, now = Date.now()): Limits | undefined {
  const limits = LIMIT_WINDOWS.flatMap((window): Limit[] => {
    const used = headers[header(window, '-utilization')], resets = headers[header(window, '-reset')];
    if (!used || !resets || !(Number(used) >= 0) || !(Number(resets) > 0)) return [];
    return [{ window, used: Number(used), resets: new Date(Number(resets) * 1000).toISOString(), reached: headers[header(window, '-status')] === 'rejected' }];
  });
  return limits.length ? { at: new Date(now).toISOString(), limits, overage: headers[header('', 'overage-in-use')] === 'true' } : undefined;
}

/** A profile's limits as last saved, or nothing: none were saved yet, or the file is not one of these. Writes nothing. */
export function readLimits(directory: string): Limits | undefined {
  try {
    const saved: unknown = JSON.parse(readFileSync(file(directory), 'utf8'));
    return valid(saved) ? saved : undefined;
  } catch { return undefined; }
}

/** Keeps the latest: `limits.json` in the profile's folder, replaced whole. Only the Pi that holds the profile calls these two,
 * and neither throws: a snapshot that cannot be saved must not fail the answer it came with. */
export function noteLimits(directory: string, headers: Record<string, string>, now = Date.now()) {
  try {
    const limits = limitsFrom(headers, now);
    if (limits) atomicWrite(file(directory), JSON.stringify(limits));
  } catch { /* The next answer saves it. */ }
}
/** Notes that the provider turned a request away for a rate limit, if `error` is that: Anthropic's error of the type
 * `rate_limit_error`, which Pi gives as the answer's error text. The windows stay as they were last counted. */
export function noteRefusal(directory: string, error: string | undefined, now = Date.now()) {
  if (!error?.includes('rate_limit_error')) return;
  try { atomicWrite(file(directory), JSON.stringify({ ...readLimits(directory) ?? { at: new Date(now).toISOString(), limits: [], overage: false }, refused: new Date(now).toISOString() } satisfies Limits)); }
  catch { /* As above. */ }
}
