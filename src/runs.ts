import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { atomicWrite } from './store.ts';
import { record } from './core/cache.ts';
import { textContent } from './transcript.ts';
import { isFinishReason, readRun, type FinishReason, type Guidance, type RunInfo, type RunState } from './run-record.ts';

export { readRun, runStates, type FinishReason, type Guidance, type RunInfo, type RunState } from './run-record.ts';

/** How a run's reports and messages start: `[id]`, or `[id · title]` (see `HEAD` in report-message.ts). */
export const reportHead = (run: { id: string; title?: string }) => `[${run.id}${run.title ? ` · ${run.title}` : ''}]`;
/** The text the agent receives, which is how Pi's queue and the session know the message. */
export const sentText = (g: Guidance) => g.sent ?? g.text;
const moves: Record<RunState, readonly RunState[]> = {
  running: ['waiting', 'paused', 'stopping', 'completed', 'failed', 'stopped', 'interrupted'],
  waiting: ['running', 'paused', 'stopping', 'completed', 'failed', 'stopped', 'interrupted'],
  paused: ['running', 'stopping', 'failed', 'stopped', 'interrupted'],
  stopping: ['stopped', 'failed', 'interrupted'],
  // A finished run only takes the outcome of a connected handoff.
  completed: ['interrupted'], failed: ['completed', 'interrupted'], stopped: ['completed', 'interrupted'], interrupted: ['completed'],
};
/** Every run state change goes through here, so a late stop cannot rewrite a finished run. Returns whether the run is now in `to` (true for a repeat, so a second stop can still abort a child that ignored the first). */
export function transition(run: RunInfo, to: RunState) {
  if (run.state !== to && !moves[run.state].includes(to)) return false;
  run.state = to; return true;
}
export const isActiveRun = (run: RunInfo) => run.state === 'running' || run.state === 'waiting' || run.state === 'stopping' || run.state === 'paused';
/** Live and working: a paused run is neither running nor finished. */
export const isRunning = (run: RunInfo) => isActiveRun(run) && run.state !== 'paused';
/** Messages queued for a run that it never read. */
export const undelivered = (run: RunInfo) => run.guidance.filter(g => g.state === 'undelivered').map(g => g.text);
/** A run's saved session, or undefined if it is missing or unreadable. */
export function savedSession(run: RunInfo) {
  try { return run.sessionFile && existsSync(run.sessionFile) ? SessionManager.open(run.sessionFile) : undefined; } catch { return undefined; }
}

/** Whether process `pid` still runs (on this machine; windows connect over a local socket). */
export function alive(pid: number) {
  try { process.kill(pid, 0); return true; } catch (error) { return record(error) && error.code === 'EPERM'; }
}
/** What a connected window in its own process tells the owner about itself (see `RunInfo.window`). */
export type RemoteWindow = Pick<RunInfo, 'id' | 'task' | 'cwd' | 'model' | 'thinking' | 'title'> & NonNullable<RunInfo['window']>;
/** A connected window still running in a Pi process of its own: only it can end its conversation. */
export const runsElsewhere = (run: RunInfo) => !!run.window && isActiveRun(run);
export function isRemoteWindow(value: unknown): value is RemoteWindow {
  return record(value) && ['id', 'task', 'cwd', 'model', 'thinking'].every(k => typeof value[k] === 'string') && /^[a-zA-Z0-9-]+$/.test(String(value.id))
    && Number.isSafeInteger(value.pid) && (value.title === undefined || typeof value.title === 'string')
    && (value.session === undefined || typeof value.session === 'string' && value.session.endsWith('.jsonl'))
    && (value.after === undefined || typeof value.after === 'number');
}
/** A finished run's saved messages: for a window, only its own conversation (see `RunInfo.window`). */
export function runMessages(run: RunInfo): AgentMessage[] {
  const messages = run.sessionFile ? sessionMessages(run.sessionFile) : [], after = run.window?.after;
  return after === undefined ? messages : messages.filter(message => message.timestamp >= after);
}
/** A window that found no owner keeps itself here, in the profile directory, for the next owner to take: `reason` once it has
 * ended, with `text` if it wrote its own handoff. One without a reason whose process is gone was killed. */
export type QueuedWindow = RemoteWindow & { reason?: FinishReason; text?: string };
const isQueuedWindow = (value: unknown): value is QueuedWindow => record(value)
  && (value.reason === undefined || isFinishReason(value.reason)) && (value.text === undefined || typeof value.text === 'string') && isRemoteWindow(value);
const queue = (profileDirectory: string) => join(profileDirectory, 'remote-windows');
export const queueWindow = (profileDirectory: string, window: QueuedWindow) => atomicWrite(join(queue(profileDirectory), `${window.id}.json`), JSON.stringify(window));
export const unqueueWindow = (profileDirectory: string, id: string) => rmSync(join(queue(profileDirectory), `${id}.json`), { force: true });
export function queuedWindows(profileDirectory: string): QueuedWindow[] {
  const dir = queue(profileDirectory);
  return (existsSync(dir) ? readdirSync(dir) : []).filter(file => file.endsWith('.json')).flatMap(file => {
    try {
      const value: unknown = JSON.parse(readFileSync(join(dir, file), 'utf8'));
      return isQueuedWindow(value) && file === `${value.id}.json` ? [value] : [];
    } catch { return []; }
  });
}

/** A connected run that has ended but whose handoff summary has not reached the main agent yet. */
export const isHandingOff = (run: RunInfo) => !isActiveRun(run) && !!run.handoff && !run.handoff.delivered;
export const CUT_OFF = 'Pi closed before this agent finished. Its partial transcript is retained.';
export function sessionMessages(file: string): AgentMessage[] {
  return SessionManager.open(file).getEntries().flatMap(e => e.type === 'message' ? [e.message] : []);
}

/** Metadata sits beside the SDK's canonical child transcripts, inside this profile. */
export class RunHistory {
  readonly records = new Map<string, RunInfo>();
  readonly warnings: string[] = [];
  private readonly directory: string;
  constructor(profileDirectory: string) {
    this.directory = join(profileDirectory, 'runs');
    const files = existsSync(this.directory) ? readdirSync(this.directory) : [];
    for (const file of files.filter(f => f.endsWith('.optchat.json'))) {
      try {
        const run = readRun(profileDirectory, file.slice(0, -'.optchat.json'.length));
        this.records.set(run.id, run);
        // A window in its own process outlives the owner that registered it: it hands off when it ends, to whoever owns the profile then.
        if (isActiveRun(run) && !(run.window && alive(run.window.pid))) {
          if (run.connected) run.handoff ??= { reason: 'owner-stopped' };
          // Paused runs wait for the user and stopping ones were stopped on purpose: neither is picked up again by itself.
          else if (run.state === 'running' || run.state === 'waiting') run.cutOff = true;
          transition(run, 'interrupted'); run.ended = Date.now();
          run.report = CUT_OFF;
          for (const g of run.guidance) if (g.state === 'queued') g.state = 'undelivered';
          this.save(run);
        }
      } catch { this.warnings.push(`Could not read run metadata: ${file}`); }
    }
    const known = new Set([...this.records.values()].map(r => r.sessionFile));
    // Make pre-inspector child sessions browsable without pretending to know their parent session.
    for (const file of files.filter(f => f.endsWith('.jsonl') && !known.has(join(this.directory, f)))) {
      try {
        const manager = SessionManager.open(join(this.directory, file));
        const messages = manager.getEntries().flatMap(e => e.type === 'message' ? [e.message] : []);
        const first = messages.find(m => m.role === 'user'), last = messages.findLast(m => m.role === 'assistant');
        const content = first?.role === 'user' ? textContent(first.content) : 'Historical child session';
        const task = content.includes('\n\nYour task:\n') ? content.split('\n\nYour task:\n').slice(1).join('\n\nYour task:\n') : content;
        const run: RunInfo = { id: manager.getSessionId(), task, cwd: manager.getCwd(), model: last?.role === 'assistant' ? last.model : 'unknown',
          thinking: 'unknown', parentSession: '', depth: 1, sessionFile: join(this.directory, file), started: first?.timestamp ?? 0,
          ended: last?.timestamp, state: last?.role === 'assistant' && last.stopReason === 'stop' ? 'completed' : 'interrupted', guidance: [] };
        this.records.set(run.id, run); this.save(run);
      } catch { this.warnings.push(`Could not read historical child: ${file}`); }
    }
  }
  save(run: RunInfo) {
    atomicWrite(join(this.directory, `${run.id}.optchat.json`), JSON.stringify(run));
    this.records.set(run.id, run);
  }
  /** The transcript goes first: left behind, it would come back at the next start as a historical child. */
  remove(id: string) {
    const file = this.records.get(id)?.sessionFile;
    if (file) rmSync(file, { force: true });
    rmSync(join(this.directory, `${id}.optchat.json`), { force: true });
    this.records.delete(id);
  }
  descendants(id: string) {
    const result: RunInfo[] = [], visited = new Set([id]);
    const visit = (parent: string) => {
      for (const run of this.records.values()) {
        if (run.parentId !== parent || visited.has(run.id)) continue;
        visited.add(run.id); result.push(run); visit(run.id);
      }
    };
    visit(id);
    return result;
  }
  list() {
    const sorted = [...this.records.values()].sort((a, b) => Number(isActiveRun(b)) - Number(isActiveRun(a)) || b.started - a.started || a.id.localeCompare(b.id));
    const descendants = new Map<string, RunInfo[]>();
    for (const run of sorted) if (run.parentId) {
      const siblings = descendants.get(run.parentId) ?? []; siblings.push(run); descendants.set(run.parentId, siblings);
    }
    const result: RunInfo[] = [], visited = new Set<string>();
    const visit = (run: RunInfo) => {
      if (visited.has(run.id)) return;
      visited.add(run.id); result.push(run);
      for (const child of descendants.get(run.id) ?? []) visit(child);
    };
    for (const run of sorted) if (!run.parentId || !this.records.has(run.parentId)) visit(run);
    for (const run of sorted) visit(run); // Keep even malformed/orphaned old trees visible.
    return result;
  }
}
