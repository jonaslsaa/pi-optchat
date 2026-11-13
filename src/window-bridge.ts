import { chmodSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { INTERRUPTED, type Children } from './agents.ts';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { record } from './core/cache.ts';
import { checkSocketPath, isWindows, profileSocket, removeStaleSocket } from './profiles.ts';
import { textContent } from './transcript.ts';
import { isActiveRun, isRemoteWindow, type RunInfo } from './runs.ts';
import { HANDOFF_REQUEST } from './prompts.ts';
import { connectWindow, isAssistant, wire, type Action, type AttachableAgent, type LiveState, type WindowMessage } from './window-client.ts';
import type { AssistantMessage, UserMessage } from '@earendil-works/pi-ai';

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
/** What a registered window may still ask: its agent and conversation are its own. */
const REMOTE_ACTIONS: readonly Action[] = ['handoff', 'tell-main'];
const SHORTENED = '\n[Display shortened; full text is saved in the transcript.]';
/** Stays under the 4 MB frame bound even when JSON escapes some characters. */
const ANSWER_LIMIT = 1_000_000;
const shorten = (text: string, limit: number) => text.length > limit ? `${text.slice(0, limit)}${SHORTENED}` : text;
/** Long text parts are cut and images dropped: the window only draws them, the owner keeps the full transcript. */
function clipContent(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  return content.map(part => !record(part) ? part : part.type === 'text' && typeof part.text === 'string' ? { ...part, text: shorten(part.text, 50_000) }
    : part.type === 'image' ? { type: 'text', text: '[image]' } : part);
}
const clip = <M extends WindowMessage>(message: M) => ({ ...message, content: clipContent(message.content) }) as M;
const clipOutput = (output: unknown) => record(output) ? { ...output, content: clipContent(output.content) } : output;
/**
 * Huge tool arguments (a large file write) would choke the socket; the window then falls back to text.
 * Partial tool output comes from any extension and may not serialize (a cycle, a BigInt); that falls back too
 * instead of throwing inside the status timer, which would take the owner's Pi down with it.
 */
const fits = (value: unknown) => { try { return JSON.stringify(value).length < 1_000_000; } catch { return false; } };

/** Call only while holding the profile lock. The owner hosts every child session. */
export async function serveWindows(directory: string, children: Children, available: () => boolean,
  report: (text: string) => Promise<void>) {
  const path = profileSocket(directory, 'windows'); checkSocketPath(path);
  removeStaleSocket(path); // A previous owner can no longer hold the profile lock.
  const connections = new Set<Socket>();
  const work = new Set<Promise<void>>();
  let closing = false;
  const server = createServer(socket => {
    if (closing) { socket.destroy(); return; }
    connections.add(socket);
    let child: string | undefined, attached = false, remote = false, cursor = 0, firstUser = true, lastStatus = '';
    // `finished`: an attached agent ended, and the view takes only `resume`, which the app's client sends (Pi's terminal attach
    // just reads a finished agent), until the agent is live again. `closing`: the view takes nothing more.
    let phase: 'open' | 'finished' | 'closing' = 'open';
    let finalMessages: AgentMessage[] | undefined;
    const controller = new AbortController();
    let queue = Promise.resolve();
    const track = (promise: Promise<void>) => { work.add(promise); void promise.finally(() => work.delete(promise)).catch(() => {}); };
    // Esc, Alt+Up and stop reply once the abort has started, not when it ends, so a tool that ignores it can't hold up this window.
    // A refusal is thrown before the abort starts, so it is already settled and wins the race.
    const started = <T>(action: Promise<T>) => { track(action.then(() => {})); return Promise.race([action, undefined]); };
    const send = wire(socket, frame => {
      if (frame.kind !== 'request') { socket.destroy(); return; }
      queue = queue.then(async () => {
        try {
          if (socket.destroyed || phase === 'closing' || phase === 'finished' && frame.action !== 'resume') throw new Error('Conversation is closing');
          if (frame.action === 'list-agents') {
            const agents: AttachableAgent[] = available() ? children.history.list()
              .filter(info => !info.connected && !!children.live(info.id)
                && (info.state === 'running' || info.state === 'waiting' || info.state === 'paused'))
              .map(info => ({ id: info.id, task: info.task.slice(0, 200), title: info.title, state: info.state })) : [];
            send({ kind: 'reply', id: frame.id, text: JSON.stringify(agents) }); return;
          } else if (frame.action === 'attach') {
            if (child) throw new Error('This window already has a conversation');
            if (!available()) throw new Error('Profile is importing or shutting down; try again when it is ready');
            const id = frame.text?.trim();
            if (!id || !/^[a-zA-Z0-9-]+$/.test(id)) throw new Error('An exact agent ID is required');
            const info = children.history.records.get(id);
            if (!info) throw new Error(`No subagent ${id} in this profile`);
            if (info.connected) throw new Error(`${id} already belongs to a connected window; attach to a background subagent instead`);
            if (frame.activeOnly && (!children.live(id) || !['running', 'waiting', 'paused'].includes(info.state)))
              throw new Error(`Subagent ${id} is no longer available in the menu. Refresh and choose a live agent.`);
            const live = children.live(id);
            const messages = children.retained(id);
            // This socket borrows the existing session, never its lifetime, slot or report destination.
            // Other views (the main window's Agents page, other terminals) stay open alongside it.
            attached = true; child = id; finalMessages = live ? undefined : messages;
            send({ kind: 'event', name: 'started', text: child, title: info.title });
            drainMessages(messages, info);
          } else if (frame.action === 'register') {
            if (child) throw new Error('This window already has a conversation');
            if (!available()) throw new Error('Profile is importing or shutting down; try again when it is ready');
            let window: unknown;
            try { window = JSON.parse(frame.text ?? ''); } catch { window = undefined; }
            if (!isRemoteWindow(window)) throw new Error('Invalid window registration');
            await children.adopt(window);
            child = window.id; remote = true;
          } else if (frame.action === 'start') {
            if (child) throw new Error('This window already has a conversation');
            if (!available()) throw new Error('Profile is importing or shutting down; try again when it is ready');
            if (!frame.text?.trim() || !frame.cwd) throw new Error('A request and working directory are required');
            [child] = await children.spawn([{ task: frame.text, cwd: frame.cwd }], frame.cwd, controller.signal, undefined, true);
            if (socket.destroyed) { await children.finish(child, closing ? 'owner-stopped' : 'disconnected'); return; }
            send({ kind: 'event', name: 'started', text: child });
          } else {
            if (!child) throw new Error('Send your first request to start a conversation');
            if (remote && !REMOTE_ACTIONS.includes(frame.action)) throw new Error('This window runs its own agent');
            if (!remote && frame.action === 'handoff') throw new Error('Only a window running its own agent hands off');
            if (frame.action === 'handoff') {
              phase = 'closing';
              // Delivered (or saved for the next start) before the reply, so the window queues it if this owner fails it.
              await children.endRemote(child, 'complete', frame.text?.trim() || undefined);
              send({ kind: 'reply', id: frame.id }); return;
            }
            if (frame.action === 'answer') {
              // The agent's last reply in full, not the display copy that events carry (headless `pi -p` prints it).
              const text = children.live(child)?.session.getLastAssistantText() ?? '';
              if (text.length > ANSWER_LIMIT) throw new Error(`The reply is over ${ANSWER_LIMIT.toLocaleString('en')} characters; the original Pi window has it in full`);
              send({ kind: 'reply', id: frame.id, text }); return;
            }
            // Esc and Alt+Up in the window, as agent-view.ts does them in the main one.
            if (frame.action === 'interrupt') { send({ kind: 'reply', id: frame.id, text: await started(children.interrupt(child)) }); return; }
            // The Agents page's stop: the agent and its own agents end, and its report says the user stopped it.
            if (frame.action === 'stop') {
              if (!attached) throw new Error('Only an agent you attached to stops from here; /complete ends this conversation');
              await started(children.stop(child)); send({ kind: 'reply', id: frame.id }); return;
            }
            if (frame.action === 'resume') {
              // Checked against the agent, not the view, which notices a finish only at its next tick.
              if (!attached || children.live(child)) throw new Error(`Only a finished agent you attached to resumes; ${child} is running, so say reaches it`);
              if (!available()) throw new Error('Profile is importing or shutting down; try again when it is ready');
              await children.resumeByUser(child, frame.text ?? '');
              phase = 'open'; finalMessages = undefined; // As the next tick would, so a say right after this one is taken.
              send({ kind: 'reply', id: frame.id }); return;
            }
            if (frame.action === 'withdraw') { send({ kind: 'reply', id: frame.id, text: children.withdraw(child) }); return; }
            if (frame.action === 'complete') {
              const live = children.live(child);
              if (live) drainMessages(children.retained(child), live.info);
              phase = 'closing';
              if (!attached) track(children.finish(child, 'complete').then(() => {}));
              send({ kind: 'event', name: 'finished', text: attached ? 'Detached. The background agent remains with its original parent.'
                : 'Conversation ended by you. The original window is stopping remaining work and preparing the handoff.' });
            } else {
              if (!frame.text?.trim()) throw new Error('Message is empty');
              if (frame.action === 'say') await children.tell(child, frame.text, 'user');
              else await report(`[${child}] User message from connected window: ${frame.text}`);
            }
          }
          send({ kind: 'reply', id: frame.id });
        } catch (error) { send({ kind: 'reply', id: frame.id, error: errorText(error) }); }
      });
      track(queue);
    });
    /** Main-agent guidance and child reports reach the session as user messages too; only what the user sent, from any view, shows as theirs. */
    const drainMessages = (messages: AgentMessage[], info: RunInfo) => {
      // The window's handoff, written once the conversation ended, is for the main agent: the window shows the conversation only.
      const end = info.handoff ? messages.findIndex(message => message.role === 'user' && textContent(message.content).startsWith(HANDOFF_REQUEST)) : -1;
      const displayable = (end < 0 ? messages : messages.slice(0, end)).filter((message): message is UserMessage | WindowMessage => message.role === 'user' || message.role === 'assistant' || message.role === 'toolResult');
      // An attachment may replay hours of tool output. Pace the history instead of overflowing the bounded wire
      // or starving the owner's event loop. The next status tick continues from the same cursor, which stays valid because
      // retained messages are only ever appended (unlike Pi's projection, which compaction and retries replace).
      let batch = 0;
      while (cursor < displayable.length) {
        if (batch++ >= 32 || socket.writableLength > 1_000_000) return false;
        const message = displayable[cursor++];
        let text = message.role === 'toolResult' ? '' : textContent(message.content);
        const task = message.role === 'user' && firstUser;
        if (task) { text = info.task; firstUser = false; }
        if (message.role === 'user') {
          // The task, and an interrupt, which continues with your queued messages, are yours too.
          // Your messages show as you typed them, also inside an interrupt's prompt, not as the skill Pi expanded them into.
          // Longest first: a skill sent without arguments is the start of the same skill sent with some.
          const typed = info.guidance.flatMap(g => g.from === 'user' && g.sent ? [{ sent: g.sent, text: g.text }] : []).sort((a, b) => b.sent.length - a.sent.length);
          for (const g of typed) text = text.replaceAll(g.sent, () => g.text);
          const yours = task || text.startsWith(INTERRUPTED) || info.guidance.some(g => g.from === 'user' && g.text === text.trim());
          if (text) send({ kind: 'event', name: 'message', from: yours ? 'user' : undefined, text: shorten(text, 200_000) });
          continue;
        }
        const clipped = clip(message);
        if (fits(clipped)) send({ kind: 'event', name: 'message', from: message.role === 'assistant' ? 'agent' : undefined, text: shorten(text, 200_000), message: clipped });
        else if (text) send({ kind: 'event', name: 'message', from: 'agent', text: shorten(text, 200_000) });
      }
      return true;
    };
    const timer = setInterval(() => {
      if (!child || remote || socket.destroyed || phase === 'closing') return;
      // Whoever resumed a finished agent (this view, another one, or the main agent's tell), the view follows it again from where it left off.
      if (phase === 'finished') { if (!children.live(child)) return; phase = 'open'; finalMessages = undefined; }
      const live = children.live(child), info = children.history.records.get(child);
      if (!info) {
        // Deleted from the Agents page: end the window (and a headless join) instead of leaving it waiting forever.
        phase = 'closing';
        send({ kind: 'event', name: 'finished', text: 'This conversation was deleted from the Agents page.' });
        return;
      }
      if (live) drainMessages(children.retained(child), info);
      // Once the conversation has ended, what its session still streams is the handoff, which is for the main agent.
      const working = info.handoff ? undefined : live;
      const preview = working?.streaming && 'content' in working.streaming ? textContent(working.streaming.content).slice(-2000) : '';
      const text = `${info.state === 'waiting' ? 'Awaiting user or child reports' : info.state} · ${info.model}\n${working ? [...working.tools.values()].map(t => t.name).join(', ') : ''}\n${preview}`;
      let state: LiveState = { state: info.state, model: info.model,
        streaming: isAssistant(working?.streaming) ? clip(working.streaming) : undefined,
        tools: working ? [...working.tools].map(([id, t]) => ({ id, name: t.name, args: t.args, output: clipOutput(t.output), started: t.started })) : [],
        // A finished child counts until its report has reached this agent, so the agent never looks idle in between.
        agents: [...children.history.records.values()].filter(run => run.parentId === child && (isActiveRun(run) || children.live(run.id))).length,
        queued: info.guidance.flatMap(g => g.state === 'queued' && g.from === 'user' ? [g.text.slice(0, 1000)] : []) };
      if (!fits(state)) state = { ...state, streaming: undefined, tools: state.tools.map(t => ({ ...t, args: {}, output: undefined })) };
      const status = JSON.stringify(state);
      if (status !== lastStatus) { lastStatus = status; send({ kind: 'event', name: 'status', text, live: state }); }
      if (!live && (attached && !isActiveRun(info) || info.handoff?.delivered)) {
        try { if (!drainMessages(finalMessages ??= children.retained(child), info)) return; }
        catch (error) { send({ kind: 'event', name: 'message', text: `Could not read the final transcript: ${errorText(error)}` }); }
        phase = attached ? 'finished' : 'closing';
        send({ kind: 'event', name: 'finished', text: attached ? `Agent ${child} is ${info.state}. Its report goes to its original parent; /complete closes only this view.` : info.handoff?.text ?? 'Conversation ended.' });
      }
    }, 150);
    const { promise: ended, resolve } = Promise.withResolvers<void>();
    const connection = ended.then(async () => {
      clearInterval(timer); controller.abort(); connections.delete(socket);
      await queue;
      // A window running its own agent outlives this owner: it hands off to whoever owns the profile when it ends.
      if (child && remote) { if (!closing) await children.endRemote(child, 'disconnected'); }
      else if (child && !attached) await children.finish(child, closing ? 'owner-stopped' : 'disconnected');
    });
    track(connection);
    socket.once('close', resolve);
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, () => { server.off('error', reject); resolve(); }); });
  if (!isWindows) chmodSync(path, 0o600);
  return async () => {
    closing = true;
    const { promise: closed, resolve } = Promise.withResolvers<void>();
    server.close(() => resolve());
    for (const socket of connections) socket.destroy();
    await closed;
    // A socket's close handler adds its cleanup after this point, so drain the tracked work instead of snapshotting it.
    while (work.size) await Promise.allSettled([...work]);
  };
}

/**
 * A headless run (`pi -p`) on a profile another Pi owns: one request to a connected subagent, its final reply,
 * then `complete`, so the main agent gets the handoff. Connects up front, so a missing session fails before the prompt.
 */
export async function joinHeadless(directory: string) {
  let last: AgentMessage | undefined;
  let settle: (outcome: { ended?: string; lost?: true }) => void = () => {};
  const outcome = new Promise<{ ended?: string; lost?: true }>(resolve => { settle = resolve; });
  const connection = await connectWindow(directory, event => {
    if (event.name === 'message' && event.from === 'agent') last = event.message;
    // Waiting with no agents of its own means the agent is waiting for its user: the reply is done. A paused agent
    // waits for the owner's user instead, and a finished one ends with `finished` once its last messages are sent.
    else if (event.name === 'status' && event.live?.state === 'waiting' && !event.live.agents) settle({});
    else if (event.name === 'finished') settle({ ended: event.text });
  }, () => settle({ lost: true }));
  let asked = false;
  return {
    async ask(text: string, cwd: string) {
      if (asked) throw new Error('A headless run joins for one request');
      asked = true;
      await connection.request('start', text, cwd);
      const { ended, lost } = await outcome;
      const reply = last;
      if (reply?.role === 'assistant' && (reply.stopReason === 'error' || reply.stopReason === 'aborted')) throw new Error(reply.errorMessage ?? `Request ${reply.stopReason}`);
      if (lost) throw new Error('Connection to the original Pi window was lost');
      if (ended !== undefined) throw new Error(`The conversation ended before a reply: ${ended}`);
      // Events carry display copies cut for length, so the reply itself is fetched whole.
      const answer = await connection.request('answer') ?? '';
      await connection.request('complete');
      connection.close();
      return answer;
    },
    close() { connection.close(); },
  };
}
