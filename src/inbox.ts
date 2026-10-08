import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { record } from './cache.ts';
import { atomicWrite } from './memory.ts';
import type { Memory } from './memory.ts';

interface Arrival { id: string; text: string; date: string }
/** Durable arrivals bridge the period before a new turn's old-history snapshot is ready. */
export class Inbox {
  private readonly file: string;
  private items: Arrival[];
  private readonly claimed = new Set<string>();
  /** Typed while a run was going: Pi holds these until a turn boundary, and Esc or dequeue hands them back to the editor without telling extensions. */
  private readonly queued = new Set<string>();
  constructor(directory: string) {
    this.file = join(directory, 'pending-inputs.json');
    const saved: unknown = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : [];
    if (!Array.isArray(saved) || !saved.every(v => record(v) && typeof v.id === 'string' && typeof v.text === 'string' && typeof v.date === 'string'))
      throw new Error('Invalid pending input journal.');
    this.items = saved;
  }
  private save() { atomicWrite(this.file, JSON.stringify(this.items)); }
  record(text: string, queued = false) {
    // Sending a handed-back input again is still one input: a second copy would never be claimed and be recovered as a duplicate.
    let id = this.items.find(i => !this.claimed.has(i.id) && i.text === text)?.id;
    if (!id) {
      const item = { id: randomUUID(), text, date: new Date().toISOString() };
      this.items.push(item); this.save(); id = item.id;
    }
    if (queued) this.queued.add(id); else this.queued.delete(id);
    return id;
  }
  /** Call once a run settles: Pi has delivered everything it still held, so a queued input nobody claimed went back to the editor. */
  dropReturned() {
    const returned = new Set([...this.queued].filter(id => !this.claimed.has(id)));
    this.queued.clear();
    if (!returned.size) return;
    this.items = this.items.filter(i => !returned.has(i.id)); this.save();
  }
  claim(text: string) { return this.claimWhere(i => i.text === text); }
  /** Pi expands `/skill:name args` after the input is journaled; match the expansion back to that input. */
  claimSkill(name: string, args = '') {
    const command = `/skill:${name}`;
    return this.claimWhere(i => i.text.startsWith(command) && /^(\s|$)/.test(i.text.slice(command.length)) && i.text.slice(command.length).trim() === args);
  }
  private claimWhere(match: (item: Arrival) => boolean) {
    const item = this.items.find(i => !this.claimed.has(i.id) && match(i));
    if (!item) return undefined;
    this.claimed.add(item.id); return item.id;
  }
  acknowledge(id: string) {
    this.items = this.items.filter(i => i.id !== id); this.claimed.delete(id); this.save();
  }
  recover(memory: Memory) {
    let count = 0;
    const receipts = new Set(memory.root.map(e => e.receipt));
    for (const item of this.items) {
      if (!receipts.has(item.id)) { memory.append('user', item.text, item.date, item.id); count++; }
    }
    this.items = []; this.claimed.clear(); this.queued.clear(); this.save(); return count;
  }
}
