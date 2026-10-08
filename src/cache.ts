import { isView } from './memory.ts';

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const BLOCK = 4;
/** Recipe §3.3: the view goes in blocks of 4 lines, then the rest (its unfinished block and `</chat>`). Text is preserved byte for byte.
 * Anthropic looks back about 20 blocks from a mark for an earlier entry, so the next call finds this call's mark. */
export function splitView(text: string) {
  const close = text.lastIndexOf('\n</chat>');
  const pieces: string[] = [];
  for (let offset = 0, at = 0, lines = 0; ;) {
    const next = text.indexOf('\n', at);
    if (next < 0 || next >= close) { pieces.push(text.slice(offset)); return pieces; }
    at = next + 1;
    if (++lines % BLOCK === 0) { pieces.push(text.slice(offset, at)); offset = at; }
  }
}
/** The view up to its last whole block: the prefix a call caches and the next call reads. */
export const cachedPrefix = (pieces: readonly string[]) => pieces.slice(0, -1).join('');

/** Anthropic: one mark on the view's last whole block plus automatic end-of-request caching. */
export function cachePayload(payload: unknown): unknown {
  if (!record(payload) || !Array.isArray(payload.messages)) return payload;
  const messages = payload.messages;
  const view = new Set<unknown>();
  for (const message of messages) {
    if (!record(message) || message.role !== 'user' || !Array.isArray(message.content)) continue;
    const at = message.content.findIndex((block: unknown) => record(block) && block.type === 'text' && typeof block.text === 'string' && isView(block.text));
    if (at < 0) continue;
    const pieces = splitView(message.content[at].text);
    const blocks = pieces.map((text, j) => ({ type: 'text', text, ...(j === pieces.length - 2 ? { cache_control: { type: 'ephemeral' } } : {}) }));
    message.content.splice(at, 1, ...blocks);
    for (const block of blocks) view.add(block);
    break;
  }
  if (!view.size) return payload;
  // Pi's default system/recent-message marks would exceed Anthropic's four-mark limit.
  for (const section of [payload.system, payload.tools]) {
    if (Array.isArray(section)) for (const item of section) if (record(item)) delete item.cache_control;
  }
  for (const message of messages) {
    if (!record(message)) continue;
    delete message.cache_control;
    if (Array.isArray(message.content)) for (const item of message.content) if (record(item) && !view.has(item)) delete item.cache_control;
  }
  payload.cache_control = { type: 'ephemeral' };
  return payload;
}
