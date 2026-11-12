import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { record } from './core/cache.ts';

// A profile's run records (`runs/<id>.optchat.json`) and how to read them, without Pi, so pi-optchat/files can list them too.

/** `paused`: interrupted by the user with nothing queued, alive and waiting for its next message. `interrupted` is a finished run cut off by Pi closing or a connected window ending. */
export const runStates = ['running', 'waiting', 'stopping', 'completed', 'failed', 'stopped', 'interrupted', 'paused'] as const;
export type RunState = typeof runStates[number];
const finishReasons = ['complete', 'disconnected', 'owner-stopped', 'failed'] as const;
export type FinishReason = typeof finishReasons[number];
export const isFinishReason = (value: unknown): value is FinishReason => finishReasons.some(reason => reason === value);
export interface RunInfo {
  id: string; task: string; cwd: string; model: string; thinking: string;
  /** The spawning agent's short label for the task, shown instead of it where there is room for one line. */
  title?: string;
  parentSession: string; sessionFile?: string; started: number; ended?: number;
  parentId?: string; depth: number;
  state: RunState; report?: string;
  connected?: boolean;
  /** A connected window whose agent runs in its own Pi process (an RPC host's second session on a busy profile): `pid` is that
   * process, `session` its Pi session file, read when the window ends. The record is all this process has of it. `after`: a window
   * that went on after /complete shares that session with the conversations before it, so only its messages from then on are its. */
  window?: { pid: number; session?: string; after?: number };
  /** `unread`: reports its subagents sent while it was paused, which it never read; its handoff includes them. */
  handoff?: { reason: FinishReason; text?: string; delivered?: boolean; unread?: string[] };
  /** Working when Pi closed or crashed: the next start resumes it (see `Children.resumeCutOff`). */
  cutOff?: boolean;
  /** `from` is missing on runs saved before senders were recorded. `sent`: what Pi queued, when it rewrote `text` (a `/skill:` line becomes the skill itself). */
  guidance: Guidance[];
}
export type Guidance = { text: string; date: number; state: 'queued' | 'delivered' | 'undelivered'; from?: 'user' | 'manager'; sent?: string };
function isRun(value: unknown): value is RunInfo {
  return record(value) && ['id', 'task', 'cwd', 'model', 'thinking', 'parentSession'].every(k => typeof value[k] === 'string')
    && typeof value.id === 'string' && /^[a-zA-Z0-9-]+$/.test(value.id)
    && runStates.includes(value.state as RunState) && typeof value.started === 'number' && Number.isFinite(value.started)
    && (value.ended === undefined || typeof value.ended === 'number')
    && (value.title === undefined || typeof value.title === 'string')
    && (value.sessionFile === undefined || typeof value.sessionFile === 'string')
    && (value.report === undefined || typeof value.report === 'string')
    && (value.connected === undefined || typeof value.connected === 'boolean')
    && (value.cutOff === undefined || typeof value.cutOff === 'boolean')
    && (value.window === undefined || record(value.window) && typeof value.window.pid === 'number' && (value.window.session === undefined || typeof value.window.session === 'string')
      && (value.window.after === undefined || typeof value.window.after === 'number'))
    && (value.handoff === undefined || record(value.handoff) && isFinishReason(value.handoff.reason)
      && (value.handoff.text === undefined || typeof value.handoff.text === 'string')
      && (value.handoff.delivered === undefined || typeof value.handoff.delivered === 'boolean')
      && (value.handoff.unread === undefined || Array.isArray(value.handoff.unread) && value.handoff.unread.every(text => typeof text === 'string')))
    && typeof value.depth === 'number' && Number.isInteger(value.depth) && value.depth >= 1
    && (value.parentId === undefined || typeof value.parentId === 'string')
    && Array.isArray(value.guidance) && value.guidance.every(g => record(g) && typeof g.text === 'string' && typeof g.date === 'number' && ['queued', 'delivered', 'undelivered'].includes(String(g.state)) && (g.from === undefined || g.from === 'user' || g.from === 'manager') && (g.sent === undefined || typeof g.sent === 'string'));
}
/** Run `id`'s record in this profile, as saved; throws if it is missing or invalid. */
export function readRun(profileDirectory: string, id: string): RunInfo {
  const directory = join(profileDirectory, 'runs');
  const run: unknown = JSON.parse(readFileSync(join(directory, `${id}.optchat.json`), 'utf8'));
  if (record(run) && run.depth === undefined) run.depth = 1;
  if (!isRun(run) || run.id !== id) throw new Error('Invalid metadata');
  // Never follow a stored transcript pointer outside this profile's run directory.
  if (run.sessionFile) run.sessionFile = join(directory, basename(run.sessionFile));
  return run;
}

/** Every run saved in this profile, connected windows included; one that can't be read is left out. */
export function readRuns(profileDirectory: string): RunInfo[] {
  const directory = join(profileDirectory, 'runs'), suffix = '.optchat.json';
  return (existsSync(directory) ? readdirSync(directory) : []).filter(file => file.endsWith(suffix)).flatMap(file => {
    try { return [readRun(profileDirectory, file.slice(0, -suffix.length))]; } catch { return []; }
  });
}
