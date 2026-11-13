import { createConnection, type Socket } from 'node:net';
import type { AssistantMessage, ToolResultMessage } from '@earendil-works/pi-ai';
import { record } from './core/cache.ts';
import { profileSocket } from './profiles.ts';

// The connected-window protocol and its client, without Pi: Pi's windows use it, and so can another app through pi-optchat/files.
// The server is serveWindows in window-bridge.ts, in the Pi that owns the profile.

/** `register` and `handoff` are a window whose agent runs in its own process (an RPC host's): it registers once it has a request,
 * and `handoff` ends it with the handoff it wrote. A window that drops its connection without one ended without /complete. */
const ACTIONS = ['list-agents', 'attach', 'start', 'say', 'tell-main', 'answer', 'interrupt', 'stop', 'resume', 'withdraw', 'complete', 'register', 'handoff'] as const;
export type Action = typeof ACTIONS[number];
const isAction = (value: unknown): value is Action => ACTIONS.some(action => action === value);
interface Request { kind: 'request'; id: number; action: Action; text?: string; cwd?: string; activeOnly?: boolean }
interface Reply { kind: 'reply'; id: number; error?: string; text?: string }
/** A tool the subagent is running right now, with its streamed output so far. */
export interface LiveTool { id: string; name: string; args: unknown; output?: unknown; started: number }
/** What the subagent is doing between finished messages: its streaming reply, running tools, and your messages it has not read yet. */
export interface LiveState { state: string; model: string; streaming?: AssistantMessage; tools: LiveTool[]; agents?: number; queued?: string[] }
/**
 * `from` marks the conversation itself (your messages and the agent's replies); other messages have no `from`.
 * `message` carries the agent's own messages (replies with tool calls, tool results) so the window can draw them with Pi's components.
 */
export interface WindowEvent {
  kind: 'event'; name: 'started' | 'message' | 'status' | 'finished'; text: string; from?: 'user' | 'agent';
  message?: WindowMessage; live?: LiveState;
  /** On `started` in an attached window: the subagent's spawn title, if it has one. */
  title?: string;
}
/** What the window draws with Pi's components: the agent's replies and its tool results. */
export type WindowMessage = AssistantMessage | ToolResultMessage;
type Frame = Request | Reply | WindowEvent;
const isMessage = (value: unknown): value is WindowMessage => record(value) && (value.role === 'assistant' || value.role === 'toolResult') && Array.isArray(value.content);
export const isAssistant = (value: unknown): value is AssistantMessage => isMessage(value) && value.role === 'assistant';
const isLive = (value: unknown): value is LiveState => record(value) && typeof value.state === 'string' && typeof value.model === 'string'
  && (value.streaming === undefined || isAssistant(value.streaming))
  && Array.isArray(value.tools) && value.tools.every(t => record(t) && typeof t.id === 'string' && typeof t.name === 'string' && typeof t.started === 'number')
  && (value.agents === undefined || typeof value.agents === 'number')
  && (value.queued === undefined || Array.isArray(value.queued) && value.queued.every(text => typeof text === 'string'));
function parse(value: unknown): Frame {
  if (!record(value)) throw new Error('Invalid window message');
  const name = value.name, action = value.action, from = value.from;
  if (value.kind === 'event' && (name === 'started' || name === 'message' || name === 'status' || name === 'finished') && typeof value.text === 'string')
    return { kind: 'event', name, text: value.text, from: from === 'user' || from === 'agent' ? from : undefined,
      message: isMessage(value.message) ? value.message : undefined, live: isLive(value.live) ? value.live : undefined,
      title: typeof value.title === 'string' ? value.title : undefined };
  if (typeof value.id !== 'number' || !Number.isSafeInteger(value.id)) throw new Error('Invalid request ID');
  if (value.kind === 'reply' && (value.error === undefined || typeof value.error === 'string') && (value.text === undefined || typeof value.text === 'string'))
    return { kind: 'reply', id: value.id, error: value.error, text: value.text };
  if (value.kind === 'request' && isAction(action)
    && (value.text === undefined || typeof value.text === 'string') && (value.cwd === undefined || typeof value.cwd === 'string')
    && (value.activeOnly === undefined || typeof value.activeOnly === 'boolean'))
    return { kind: 'request', id: value.id, action, text: value.text, cwd: value.cwd, activeOnly: value.activeOnly as boolean | undefined };
  throw new Error('Invalid window message');
}

/** Local JSONL protocol, bounded before parsing. On POSIX the socket file is mode 0600, so only its OS user can connect; a Windows named pipe has no file permissions, so its hashed profile name is the only separation. */
export function wire(socket: Socket, receive: (frame: Frame) => void) {
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('error', () => {});
  socket.on('data', (text: string) => {
    buffer += text;
    if (buffer.length > 4_000_000) { socket.destroy(); return; }
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      try { receive(parse(JSON.parse(line))); } catch { socket.destroy(); return; }
    }
  });
  return (frame: Frame) => {
    if (socket.destroyed) return;
    if (socket.writableLength > 4_000_000) { socket.destroy(); return; }
    socket.write(JSON.stringify(frame) + '\n');
  };
}

export async function connectWindow(directory: string, event: (event: WindowEvent) => void, disconnected: () => void, connectTimeout = 5000) {
  const socket = createConnection(profileSocket(directory, 'windows'));
  let next = 0;
  const pending = new Map<number, { resolve: (text?: string) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  const send = wire(socket, frame => {
    if (frame.kind === 'event') { event(frame); return; }
    if (frame.kind !== 'reply') { socket.destroy(); return; }
    const request = pending.get(frame.id); if (!request) return;
    clearTimeout(request.timer); pending.delete(frame.id);
    if (frame.error) request.reject(new Error(frame.error)); else request.resolve(frame.text);
  });
  socket.on('close', () => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Connection to the original Pi window was lost')); }
    pending.clear(); disconnected();
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve); socket.once('error', reject);
    socket.setTimeout(connectTimeout, () => socket.destroy(new Error('Profile owner did not respond')));
  }).catch((error: unknown) => {
    const code = record(error) ? error.code : undefined;
    throw code === 'ENOENT' || code === 'ECONNREFUSED'
      ? new Error('No running OptChat session on this profile accepts connections. A headless run (pi -p) holding it does not accept connections; once it exits, open the profile instead.', { cause: error }) : error;
  });
  socket.setTimeout(0);
  return {
    async request(action: Action, text?: string, cwd?: string, options: { timeout?: number; activeOnly?: boolean } = {}) {
      if (socket.destroyed) throw new Error('The original Pi window is disconnected');
      if (text && text.length > 256_000) throw new Error('Connected-window messages are limited to 256,000 characters');
      const id = next++;
      return await new Promise<string | undefined>((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('Owner response timed out; closing this connection')); socket.destroy(); }, options.timeout ?? 120_000);
        pending.set(id, { resolve, reject, timer }); send({ kind: 'request', id, action, text, cwd, activeOnly: options.activeOnly });
      });
    },
    close() { socket.destroy(); },
  };
}

export interface AttachableAgent { id: string; task: string; title?: string; state: string }
/** Query the owner, not run metadata on disk: it knows which main/terminal views are actually open. */
export async function listAttachableAgents(directory: string, timeout = 2000): Promise<AttachableAgent[]> {
  const deadline = Date.now() + timeout;
  const connection = await connectWindow(directory, () => {}, () => {}, timeout);
  try {
    const agents: unknown = JSON.parse(await connection.request('list-agents', undefined, undefined, { timeout: Math.max(1, deadline - Date.now()) }) ?? '[]');
    if (!Array.isArray(agents) || !agents.every(agent => record(agent) && typeof agent.id === 'string'
      && typeof agent.task === 'string' && (agent.title === undefined || typeof agent.title === 'string') && (agent.state === 'running' || agent.state === 'waiting' || agent.state === 'paused')))
      throw new Error('Invalid background agent list from the profile owner');
    return agents;
  } finally { connection.close(); }
}

/**
 * One of a profile's subagents, opened by its exact ID (see `readRuns`) in the Pi that owns the profile: its conversation so far,
 * then live, arrives through `event`. `say` sends it a message as the user, `resume` does once it has finished, `interrupt` cuts
 * its current turn (it goes on with messages it has not read yet, or waits for the next one), `stop` ends it, and its report goes
 * to its parent as from the Agents page. Closing detaches only: the agent keeps running. Throws if no Pi has the profile open or
 * it has no such agent.
 */
export async function attachAgent(profileDirectory: string, id: string, event: (event: WindowEvent) => void, disconnected: () => void = () => {}) {
  const connection = await connectWindow(profileDirectory, event, disconnected);
  try { await connection.request('attach', id); }
  catch (error) { connection.close(); throw error; }
  return {
    async say(text: string) { await connection.request('say', text); },
    /** What the interrupt did, as the owner words it. */
    interrupt: () => connection.request('interrupt'),
    async stop() { await connection.request('stop'); },
    /**
     * A finished agent goes on with `text` from the user, in its earlier conversation; its new report goes to its parent. As with
     * the main agent's tell, only the main agent's own subagents resume: a nested one throws "Only <parent> can resume it…", and a
     * live one refuses (use `say`).
     */
    async resume(text: string) { await connection.request('resume', text); },
    close: () => connection.close(),
  };
}
export type AttachedAgent = Awaited<ReturnType<typeof attachAgent>>;
