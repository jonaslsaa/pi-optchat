import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { GuidanceArchive, guidanceKey, type GuidanceRevision } from './guidance.ts';
import { atomicWrite } from './store.ts';
import { record } from './cache.ts';
import { validGuidanceRef, validRequestId, type GuidanceRef } from './guidance-ref.ts';
export { validGuidanceRef, type GuidanceRef } from './guidance-ref.ts';

export const GUIDANCE_REQUEST = 'optchat.guidance.request';
export interface GuidanceRecallRef extends GuidanceRef { work?: string }
interface Request extends GuidanceRef { agent: string; revision: string; prepared: string; after?: string }

/** One identity per agent request, independent of timestamps and of other agents' observations. */
export class GuidanceRequests {
  private pending?: GuidanceRef;
  latest?: GuidanceRef;
  readonly archive: GuidanceArchive;
  constructor(profile: string) { this.archive = new GuidanceArchive(profile); }
  input() { return this.pending ??= { request: randomUUID() }; }
  resetPending() { this.pending = undefined; this.latest = undefined; }
  prepare(revision: GuidanceRevision, agent: string, messages: readonly AgentMessage[]): GuidanceRef {
    const ref = this.pending ?? { request: randomUUID() };
    const last = messages.findLast(message => message.role !== 'system');
    const request: Request = { ...ref, agent, revision: revision.id, prepared: new Date().toISOString(), ...(last ? { after: guidanceKey(last) } : {}) };
    atomicWrite(join(this.archive.directory, 'requests', `${ref.request}.json`), JSON.stringify(request, null, 2));
    this.pending = undefined;
    return this.latest = ref;
  }
  describe(refs: readonly GuidanceRecallRef[]) {
    if (!refs.length) return '';
    const records = [...new Set(refs.map(ref => ref.request))].map(id => {
      if (!validRequestId(id)) throw new Error('Invalid guidance request reference');
      const path = join(this.archive.directory, 'requests', `${id}.json`);
      let request: Request;
      try { request = JSON.parse(readFileSync(path, 'utf8')) as Request; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { request: id, unavailable: 'No prepared request record; this input may not have reached a model request.' };
        throw error;
      }
      if (request.request !== id || typeof request.agent !== 'string') throw new Error(`Damaged guidance request: ${path}`);
      const revision = this.archive.revision(request.revision);
      return { ...request, work: [...new Set(refs.filter(ref => ref.request === id).flatMap(ref => ref.work ? [ref.work] : []))], files: revision.files };
    });
    const descriptions = records.map(record => 'unavailable' in record ? `Request ${record.request}: ${record.unavailable}` :
      `Request ${record.request}, agent ${record.agent}${record.work.length ? ` (${record.work.join('; ')})` : ''}:\n${record.files.map((file, index) => `${index + 1}. ${file.path} (${file.scope}) → ${file.supplied}`).join('\n') || '(no applicable guidance sources)'}`);
    let text = descriptions.join('\n\n');
    if (text.length > 4000) {
      const json = JSON.stringify(records, null, 2), id = createHash('sha256').update(json).digest('hex');
      const path = join(this.archive.directory, 'recall', `${id}.json`);
      atomicWrite(path, json);
      text = `${records.length} request associations; complete ordered source references: ${path}`;
    }
    return `<historical_guidance>\nGuidance associated with this work, preserved when its requests were prepared. These copies explain earlier work; opening them does not replace current applicable guidance.\n${text}\n</historical_guidance>`;
  }
}

/** Reconstruct child associations from explicit request boundaries in its retained transcript, never by time proximity. */
export function transcriptGuidance(entries: readonly SessionEntry[], tail?: AgentMessage) {
  const refs = new Map<number, GuidanceRef>();
  let current: GuidanceRef | undefined, index = 0;
  let inputs: number[] = [];
  for (const entry of entries) {
    if (entry.type === 'custom' && entry.customType === GUIDANCE_REQUEST) {
      if (!validGuidanceRef(entry.data)) throw new Error('Invalid transcript guidance request');
      current = entry.data;
      for (const input of inputs) refs.set(input, current);
      inputs = [];
    }
    if (entry.type !== 'message') continue;
    const message = entry.message;
    if (message.role === 'user') inputs.push(index);
    else if (message.role !== 'system' && current) refs.set(index, current);
    index++;
  }
  if (tail && current && tail.role === 'assistant') refs.set(index, current);
  return refs;
}

/** Recall decorations are transient: canonical tool text, replay and compaction never contain these annotations. */
export function withGuidanceRecall(messages: AgentMessage[], describe: (refs: GuidanceRecallRef[]) => string) {
  return messages.map(message => {
    if (message.role !== 'toolResult' || message.toolName !== 'zoom' || !record(message.details)) return message;
    const refs = message.details.optchatGuidanceRecall;
    if (refs === undefined) return message;
    if (!Array.isArray(refs) || !refs.every((ref): ref is GuidanceRecallRef => validGuidanceRef(ref) && (!('work' in ref) || typeof ref.work === 'string'))) throw new Error('Invalid recalled guidance references');
    const text = describe(refs);
    return text ? { ...message, content: [...message.content, { type: 'text' as const, text }] } : message;
  });
}
