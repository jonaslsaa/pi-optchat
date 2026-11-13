import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { BeforeAgentStartEvent, ExtensionAPI, ExtensionCommandContext, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { readMemory, type Memory } from './memory.ts';
import { fingerprint } from './store.ts';
import { loadConfig, memoryDirectory, profilePath, readInstructions } from './profiles.ts';
import { allowSearch, IMPORT_GUIDANCE, SEARCH_DOC, VIEW_DOC } from './core/prompts.ts';
import { WINDOW, WINDOW_STEERABLE, windowHandoff } from './prompts.ts';
import { placeView } from './core/messages.ts';
import { connectWindow } from './window-client.ts';
import { HANDOFF_TIMEOUT, handoffText } from './handoff.ts';
import { queueWindow, readRun, runMessages, unqueueWindow, type FinishReason, type RemoteWindow } from './runs.ts';
import { textContent } from './transcript.ts';

/**
 * What this Pi is to its profile, for RPC hosts: `setStatus` with this key carries it as JSON (see `Role`).
 * `window.connected`: whether the window reaches the profile's owner now; `completed`: /complete has handed off.
 */
export const ROLE_STATUS = 'optchat.role';
export type Role = { role: 'owner'; profile: string }
  | { role: 'window'; profile: string; id: string; connected: boolean; completed: boolean; after?: number };
/** Tools that need the owner's agents: a window delegates nothing. */
const OWNER_TOOLS = ['spawn', 'tell', 'models'];
const RECONNECT_MS = 5000;
/** The closing message that asks a window for its handoff (`windowHandoff`). */
const HANDOFF_TYPE = 'optchat-handoff-request';
/** Marks where a window's conversation completed in its Pi session (see `after`). */
const COMPLETED_TYPE = 'optchat-window-completed';

/**
 * A connected window whose agent runs here, in its own Pi process: an RPC host's second session on a profile another Pi owns.
 * Pi's own agent loop answers, so the host shows everything and its tools, approvals and MCP stay its own. Memory is read from disk
 * each run and never written; the profile's owner keeps this conversation's record and gets its handoff over the window socket.
 * With no owner to reach, the window queues itself in the profile directory for the next one (see `queueWindow`).
 */
export async function openRemoteWindow(pi: ExtensionAPI, ctx: ExtensionContext, profile: string, { requireOwner = false } = {}) {
  const dir = profilePath(profile), id = randomUUID().slice(0, 8);
  // A session that goes on after /complete, now or resumed later, is a new conversation: what came before is not this window's.
  // Its branch only: a marker on a branch the user left behind ends nothing here.
  const ended = ctx.sessionManager.getBranch().findLast(entry => entry.type === 'custom' && entry.customType === COMPLETED_TYPE);
  const after = ended ? Date.parse(ended.timestamp) : undefined;
  if (!existsSync(dir)) throw new Error(`Profile ${profile} does not exist.`);
  /** `read`: the files' fingerprint when `memory` was read, taken before it, so a change meanwhile is read next time. */
  let read = fingerprint(memoryDirectory(dir)), memory = await readMemory(memoryDirectory(dir));
  const refresh = async () => {
    const directory = memoryDirectory(dir), now = fingerprint(directory);
    if (now !== read) { memory = await readMemory(directory); read = now; }
  };
  type Connection = Awaited<ReturnType<typeof connectWindow>>;
  let connection: Connection | undefined, registered = false, queued = false, completed = false, closed = false;
  /** The first request, once there is one: until then there is nothing to register or hand off. */
  let task: string | undefined;
  /** The view goes before the request of the run it was read for, and stays there while it doesn't change, so the rest stays cached. */
  let view: string | undefined, anchor: number | undefined, anchoring = false, handingOff = false;
  const shown = new Map<string, string>();
  /** Sent only when it changes: the reconnect timer asks every few seconds. */
  const publish = () => {
    if (closed) return; // Pi's context is gone with the session.
    const show = (key: string, text: string) => { if (shown.get(key) !== text) { shown.set(key, text); ctx.ui.setStatus(key, text); } };
    if (ctx.mode === 'rpc') show(ROLE_STATUS, JSON.stringify({ role: 'window', profile, id, connected: !!connection, completed, ...(after === undefined ? {} : { after }) } satisfies Role));
    show('optchat', `OptChat: ${profile} · ${completed ? 'completed' : `connected window${connection ? '' : ' · main window not reachable'}`}`);
  };
  /** `required`: only when the window opens with --optchat-connect join; later it falls back to the queue like any window. */
  const connect = async (required = false) => {
    if (connection) return;
    let opened: Connection | undefined;
    try {
      opened = await connectWindow(dir, () => {}, () => {
        if (!opened || connection !== opened) return;
        connection = undefined; registered = false; publish();
      }, 2000);
      connection = opened;
    } catch (error) { if (required) throw error; }
    publish();
  };
  const self = (): RemoteWindow => {
    const model = ctx.model, session = ctx.sessionManager.getSessionFile();
    return { id, task: task ?? '', cwd: ctx.cwd, model: model ? `${model.provider}/${model.id}` : 'unknown', thinking: pi.getThinkingLevel(), pid: process.pid, ...(session ? { session } : {}), ...(after === undefined ? {} : { after }) };
  };
  /**
   * Connects, and registers with the owner once there is a request; without one reachable, queues itself so a kill can't lose the
   * conversation. One at a time: the reconnect timer and a new run may both ask.
   */
  let syncing: Promise<void> | undefined;
  const register = ({ quiet = false } = {}) => syncing ??= (async () => {
    try {
      await connect();
      if (task === undefined || completed) return;
      if (connection && !registered) {
        try {
          await connection.request('register', JSON.stringify(self()));
          registered = true;
          if (queued) { unqueueWindow(dir, id); queued = false; }
        } catch (error) { if (!quiet) ctx.ui.notify(`OptChat could not register this window with the main one: ${error instanceof Error ? error.message : String(error)}`, 'warning'); }
      }
      if (!registered && !queued) { queueWindow(dir, self()); queued = true; }
    } finally { syncing = undefined; }
  })();
  // An owner that opens or restarts later gets this window too, so its socket can tell it when the window dies.
  const reconnect = setInterval(() => { if (!connection || task !== undefined && !registered) void register({ quiet: true }); }, RECONNECT_MS);
  reconnect.unref();
  /** Hands the conversation to the owner, or queues it ended. `text`: the handoff the window wrote; without one the owner's compactor writes it. */
  const end = async (reason: FinishReason, text?: string) => {
    if (task === undefined) { connection?.close(); return; }
    await register();
    if (connection && registered) {
      try {
        // A dropped connection is itself an ending without /complete, which the owner hands off from the transcript.
        if (reason === 'complete') await connection.request('handoff', text);
        connection.close(); return;
      } catch {}
    }
    queueWindow(dir, { ...self(), reason, ...(text ? { text } : {}) }); queued = true;
    connection?.close();
  };
  const syncTools = (search: boolean) => {
    const tools = pi.getActiveTools().filter(name => !OWNER_TOOLS.includes(name) && name !== 'search');
    pi.setActiveTools(search ? [...tools, 'search'] : tools);
  };
  try { await connect(requireOwner); } catch (error) { clearInterval(reconnect); throw error; }
  syncTools(loadConfig(dir).memorySearch);
  publish();

  return {
    id, profile, session: ctx.sessionManager.getSessionId(),
    get completed() { return completed; },
    memory: (): Memory => memory,
    /** A subagent's chat, for zoom: the owner's run record names its transcript. */
    transcript(run: string): AgentMessage[] | undefined {
      if (!/^[\w-]+$/.test(run)) return undefined;
      try {
        const saved = readRun(dir, run);
        return saved.sessionFile ? runMessages(saved) : undefined;
      } catch { return undefined; }
    },
    async beforeRun(event: BeforeAgentStartEvent) {
      const config = loadConfig(dir);
      task ??= event.messageType === 'user' ? event.prompt : textContent(event.message.content);
      if (!handingOff) {
        // Read again only when the files changed. Read while the owner may be writing: a record it hasn't finished can fail the
        // read, and the last snapshot stays.
        try { await refresh(); } catch {}
        const fresh = memory.render();
        if (fresh !== view || anchor === undefined) { view = fresh; anchoring = true; }
      }
      syncTools(config.memorySearch);
      event.systemPromptOptions.customPrompt = allowSearch(`${WINDOW}\n\n${VIEW_DOC}${config.memorySearch ? SEARCH_DOC : ''}`, config.memorySearch);
      event.systemPromptOptions.sections.instructions = [readInstructions(dir), IMPORT_GUIDANCE, WINDOW_STEERABLE].join('\n\n');
      await register();
    },
    /** Pi's messages with the view put in front of the request it was read for. */
    context<M extends AgentMessage>(messages: M[]) {
      // System messages carry the prompt and tool state (the first, then any changes), not the conversation: they all stay.
      const own = after === undefined ? messages : messages.filter(message => message.role === 'system' || message.timestamp >= after);
      if (view === undefined) return own;
      if (anchoring) { anchor = undefined; anchoring = false; }
      const placed = placeView(own, view, anchor);
      anchor = placed.anchor;
      return placed.messages;
    },
    /** /tell-main: a message to the main agent. */
    async tell(text: string) {
      if (!text.trim()) throw new Error('Message is empty');
      if (task === undefined) throw new Error('Send your first request first');
      await register();
      if (!connection || !registered) throw new Error('No main window is reachable');
      await connection.request('tell-main', text);
    },
    /** /complete: the window writes its handoff as one more turn of its own (its context still cached), then hands it to the owner. */
    async complete(command: ExtensionCommandContext) {
      if (completed) { command.ui.notify('This conversation is already completed.', 'info'); return; }
      if (!command.isIdle()) { command.abort(); await command.waitForIdle(); }
      let text: string | undefined;
      if (task !== undefined) try { text = await writeHandoff(command); }
      catch (error) { command.ui.notify(`This window could not write its handoff, so the main window's compactor writes it: ${error instanceof Error ? error.message : String(error)}`, 'warning'); }
      await end('complete', text);
      pi.appendEntry(COMPLETED_TYPE, {});
      completed = true; clearInterval(reconnect); publish();
      command.ui.notify(task === undefined ? 'Nothing to hand off: this conversation had no request.'
        : queued ? 'Completed. No main window is open; the handoff waits in the profile for the next one.' : 'Completed. The main agent has the handoff.', 'info');
    },
    /** Pi is closing this session: the owner hands it off from the transcript once the connection drops. */
    async close() {
      closed = true; clearInterval(reconnect);
      if (!completed) await end('disconnected'); else connection?.close();
    },
  };

  async function writeHandoff(command: ExtensionCommandContext) {
    handingOff = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Hidden from the host's chat: it's OptChat's request, not the user's; the handoff that answers it shows.
      // Pi marks the run started before sendMessage returns, so waitForIdle waits for it.
      pi.sendMessage({ customType: HANDOFF_TYPE, content: windowHandoff('complete', { undelivered: [], unread: [], stopped: [] }), display: false }, { triggerTurn: true });
      await Promise.race([command.waitForIdle(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => { command.abort(); reject(new Error('timed out')); }, HANDOFF_TIMEOUT);
      })]);
    } finally { clearTimeout(timer); handingOff = false; }
    // Its final reply after the request: text next to an earlier tool call never counts.
    const branch = command.sessionManager.getBranch();
    const request = branch.findLastIndex(entry => entry.type === 'custom_message' && entry.customType === HANDOFF_TYPE);
    const reply = request >= 0 ? branch.slice(request).flatMap(entry => entry.type === 'message' ? [entry.message] : []).findLast(message => message.role === 'assistant') : undefined;
    if (reply?.role !== 'assistant') throw new Error('it did not answer');
    return handoffText(reply);
  }
}
