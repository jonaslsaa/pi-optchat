import {
  AssistantEntry, CompactionTask, defineExtension, defineTask, defineTool, GenerationTask, hook, InboxDoc, LiveDoc, ResetEntry, ROOT_CONVERSATION_ID,
  section, ToolResultEntry, UserEntry, type Conversation, type ConversationId, type EntryId, type EntryRecord, type GenerationHooks, type Harness,
  type HarnessOptions, type ToolExecutionResult,
} from '@earendil-works/pi-durable';
import type { Static, TSchema } from 'typebox';
import { allowSearch, boundedMessage, cachePayload, completedExchange, CONTINUITY, logMessage, memoryTools, refreshBudget, refreshedRun, refreshPoint, SEARCH_DOC, searchTool, textContent, TURN_REFRESHED, VIEW_DOC, withView, type Memory } from '../core/index.ts';

type Context = Parameters<Harness['commit']>[1];
type Message = Parameters<GenerationHooks['beforeRequest']>[0]['messages'][number];
type Models = Exclude<HarnessOptions['models'], () => unknown>;

/** The entries that are the chat: other kinds (system prompt changes, resets, compactions, other extensions' own) stay out of memory. */
const CHAT = new Set([UserEntry.kind, AssistantEntry.kind, ToolResultEntry.kind]);
const chat = (entry: EntryRecord) => CHAT.has(entry.kind) ? entry.model ?? [] : [];
/** What memory logs of an entry: its chat, or a reset's note (`Conversation.reset(text)`, a tool's handoff) marked as one. Pi sends
 * the note in the context it starts, which is logged only once it ends, so the model never sees it twice. */
const remembered = (entry: EntryRecord) => !ResetEntry.is(entry) ? chat(entry)
  : (entry.model ?? []).map(note => ({ role: 'user' as const, content: `[Handoff note] ${textContent(note.content)}`, timestamp: note.timestamp }));
/** Each message OptChat logs from a Pi entry carries the entry's id, so the log itself says how far it has read Pi's transcript. */
const RECEIPT = 'pi:';
/** The answer that ends a run, whether it succeeded, failed or was aborted. */
const endsRun = (m: Message) => m.role === 'assistant' && m.stopReason !== 'toolUse';
const encoder = new TextEncoder();

/** One of core's memory tools as a Pi Durable tool, its arguments typed by its own schema. */
const durableTool = <P extends TSchema>(tool: {
  name: string; description: string; parameters: P;
  execute: (callId: string, args: Static<P>) => Promise<{ content: ToolExecutionResult['output'] }>;
}) => defineTool({
  name: tool.name, description: tool.description, parameters: tool.parameters, replay: 'safe',
  execute: async (args, api) => ({ output: (await tool.execute(api.callId, args)).content }),
});

export interface OptChatOptions {
  memory: Memory;
  /** The conversation OptChat remembers; Pi Durable's root by default. Other conversations that select the extension are left alone. */
  conversation?: ConversationId;
  /** The memory part of the system prompt: VIEW_DOC (plus CONTINUITY and SEARCH_DOC as set) by default. */
  prompt?: string;
  /** Offers the `search` tool. Off by default, as in Pi. */
  search?: boolean;
  /** The previous exchange is sent in full after the view when it is at most this many bytes; 0 never sends it. */
  previousExchangeBytes?: number;
  /** When a run's messages since the last refresh pass this share of the model's window, they move into memory and the run goes
   * on with a fresh view, as Pi's Turn refresh threshold (#146). 0.3 by default; 0 is off. */
  refreshAt?: number;
}

/** OptChat's memory for one Pi Durable conversation. Install `extension` in the registry Harness.open gets, then `attach` the opened
 * Harness. Each request is built as OptChat builds it in Pi: the view, the previous exchange and the current context, so the model
 * never sees Pi's older transcript. When the conversation goes idle, OptChat resets Pi's context and a background task logs what the
 * reset ended into memory and builds its summaries; Pi Durable runs that task, and wakes the Durable Object for it after an eviction.
 * Turn Pi's own compaction off (`settings.compaction.enabled: false`); the extension also declines any that starts. */
export function optchat({ memory, conversation: id = ROOT_CONVERSATION_ID, prompt, search = false, previousExchangeBytes = 16_000, refreshAt = 0.3 }: OptChatOptions) {
  let harness: Harness | undefined;
  let context: Context | undefined;
  /** The Pi entry logging resumes after: messages before the context's head are logged, the rest are sent as they are. On open it is
   * the one before the newest entry in memory, which is read again: a restart may have cut it off between its records (an answer
   * with tool calls makes several), so the first `saved` records it makes, which memory has, are skipped. */
  let logged = 0, saved = 0;
  const newest = memory.root.findLast(e => e.receipt?.startsWith(RECEIPT))?.receipt;
  if (newest) { logged = Number(newest.slice(RECEIPT.length)) - 1; saved = memory.root.filter(e => e.receipt === newest).length; }
  const resumed = new Proxy(memory, {
    get: (target, key) => key !== 'append' ? Reflect.get(target, key) : (...args: Parameters<Memory['append']>) => saved > 0 ? void saved-- : target.append(...args),
  });
  let logging = Promise.resolve();
  /** What a context's requests share, fixed when its first one is built so they read the same cached prefix. */
  let turn: { head: EntryId | undefined; view: string; previous: Message[] } | undefined;

  const opened = () => {
    if (!harness || !context) throw new Error('OptChat is not attached to a Harness yet.');
    return { harness, context };
  };
  const handle = async (ctx: Context): Promise<Conversation> => {
    const conversation = await opened().harness.conversation(id, ctx);
    if (!conversation) throw new Error(`No conversation ${id}.`);
    return conversation;
  };
  /** Logs Pi's entries before `head` that memory doesn't have yet, one caller at a time. A call that fails (aborted, say) leaves
   * the next one to carry on from the last entry it logged. */
  const logUpTo = (conversation: Conversation, head: EntryId, ctx: Context) => {
    const run = logging.then(async () => {
      let cursor: Parameters<Conversation['entries']>[2];
      do {
        if (logged + 1 > head - 1) return;
        const page = await conversation.entries({ order: 'ascending', minEntryId: logged + 1 as EntryId, maxEntryId: head - 1 as EntryId }, 256, cursor, ctx);
        for (const entry of page.items) {
          // Once a save failed, memory refuses appends: requests keep the view it has, and a restart logs the rest from Pi's transcript.
          if (memory.saveError) return;
          for (const message of remembered(entry)) logMessage(resumed, message, { receipt: `${RECEIPT}${entry.id}` });
          logged = entry.id;
        }
        cursor = page.next;
      } while (cursor);
    });
    logging = run.catch(() => {});
    return run;
  };
  /** The last run before `head`, from Pi's transcript, if it was answered and is short enough to send whole. It is read from the
   * entries, not the context's messages, which leave failed and aborted answers out and so would join a run to the one before.
   * A text-only answer ends a run here even when steering followed it in the same Pi run. */
  const previousBefore = async (conversation: Conversation, head: EntryId, ctx: Context) => {
    if (!previousExchangeBytes) return [];
    const [last] = (await conversation.entries({ order: 'descending', maxEntryId: head - 1 as EntryId }, 1, undefined, ctx)).items;
    if (!last) return [];
    const messages = (await conversation.context(ctx, { at: last.id })).entries.flatMap(chat);
    const start = messages.slice(0, messages.findLastIndex(m => m.role === 'user')).findLastIndex(endsRun) + 1;
    const exchange = completedExchange(messages.slice(start));
    const bytes = exchange.reduce((sum, m) => sum + encoder.encode(textContent(m.content)).length, 0);
    return bytes <= previousExchangeBytes ? exchange : [];
  };
  const beforeRequest: GenerationHooks['beforeRequest'] = async ({ messages }, api, ctx) => {
    if (api.conversationId !== id) return undefined;
    const conversation = await handle(ctx);
    const { head, entries } = await conversation.context(ctx);
    if (!turn || turn.head !== head?.id) {
      if (head) await logUpTo(conversation, head.id, ctx);
      await memory.settle(ctx.abortSignal);
      turn = { head: head?.id, view: memory.render(), previous: head ? await previousBefore(conversation, head.id, ctx) : [] };
    }
    const at = messages.findIndex(m => m.role !== 'system');
    if (at < 0) return undefined;
    // A tool result over 30K characters is sent as its head and tail, as in Pi.
    const run = messages.slice(at).map(boundedMessage), shared = turn;
    // `run` is the whole context, which can hold more than one run: inputs queued with no idle reset between them, or a reset's note
    // first. The run being answered starts at its task, the last of the user messages after the newest finished answer; a refresh
    // moves what comes before it into memory with the steps it cuts, and a steer before the cut too, as in Pi.
    let task = run.findLastIndex(endsRun) + 1;
    while (run[task + 1]?.role === 'user') task++;
    const own = run.slice(task);
    /** The run's answers and their entries. Pi Durable's messages are copies of its entries', so an answer is found by its first
     * tool call's id, or its timestamp without one. */
    const answer = (m: Message) => m.role === 'assistant' ? m.content.find(c => c.type === 'toolCall')?.id ?? m.timestamp : undefined;
    const steps = entries.flatMap(entry => {
      const sent = AssistantEntry.is(entry) && entry.model?.[0];
      const i = sent ? own.findIndex(m => answer(m) === answer(sent)) : -1;
      return i > 0 ? [{ entry, i }] : [];
    });
    /** Logs Pi's entries before `end`, rebuilding the view if that logged anything. False once a save failed: memory then lacks
     * part of the run, so it is sent whole. */
    const logThrough = async (end: EntryId) => {
      const count = memory.root.length;
      await logUpTo(conversation, end, ctx);
      if (memory.saveError) return false;
      if (memory.root.length !== count) { await memory.settle(ctx.abortSignal); shared.view = memory.render(); }
      return true;
    };
    // Once a refresh has logged part of this context, an earlier run in it that has ended goes into memory whole, as the reset it
    // missed would have done: a run queued behind a long one doesn't send it again.
    const ended = task > 0 && logged > (head?.id ?? 0) && run[task - 1].role === 'assistant'
      ? entries.find(entry => AssistantEntry.is(entry) && entry.model?.[0] && answer(entry.model[0]) === answer(run[task - 1])) : undefined;
    const whole = ended && await logThrough(ended.id + 1 as EntryId) ? own : run;
    // A refresh logs the run up to the answer it cuts at, so once any of its answers is in the log, the run is sent from the first
    // answer after it, after a restart too; a restart in the middle of that logging leaves the rest of it to do.
    let keep = 0;
    const kept = steps.some(s => s.entry.id <= logged) ? steps.find(s => s.entry.id > logged) : undefined;
    if (kept && await logThrough(kept.entry.id)) keep = kept.i;
    const { model } = await conversation.agent(ctx);
    const refresh = !memory.saveError && refreshPoint(own, keep, refreshBudget(model && api.models.getModel(model.provider, model.modelId)?.contextWindow, refreshAt));
    const cut = refresh && steps.find(s => s.i === refresh.cut);
    if (cut && await logThrough(cut.entry.id)) keep = cut.i;
    const sent = keep ? refreshedRun(own, keep, TURN_REFRESHED) : whole;
    return { messages: withView([...messages.slice(0, at), ...turn.previous, ...sent], turn.view) };
  };

  const Remember = defineTask<Record<string, never>, { phase: 'remember' }, null>({
    name: 'optchat.remember', version: 1,
    initial: () => ({ phase: 'remember' }),
    phases: {
      // Logs what the newest reset ended and waits until the next turn's view is built, or every summary owed has failed. A phase
      // cut off by an eviction runs again from the top: logging skips what is in memory, and memory rebuilds what it owes on open.
      remember: async (_task, runtime, ctx) => {
        const conversation = await handle(ctx), { head } = await conversation.context(ctx);
        if (head) await logUpTo(conversation, head.id, ctx);
        await memory.settle(runtime.signal);
        await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: null } }), ctx);
      },
    },
    abort: (_task, runtime, ctx) => runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx),
  });

  /** Once the conversation is idle with a chat in its context, resets the context and starts remembering it, in one commit. */
  const resetIfIdle = async () => {
    const { harness, context } = opened();
    const busy = async () => !!(await harness.snapshot(LiveDoc, id, context))?.run || !!(await harness.snapshot(InboxDoc, id, context))?.items.length;
    if (await busy() || !(await (await handle(context)).context(context)).entries.some(e => chat(e).length)) return;
    await harness.commit(async tx => {
      // Checked again where it is atomic: an input that came in meanwhile keeps its context.
      if ((await tx.doc(LiveDoc, id)).run || (await tx.doc(InboxDoc, id)).items.length) return;
      await tx.appendEntry(id, { kind: ResetEntry.kind, head: 'self' });
      await tx.createTask(Remember, {}, { ownership: { kind: 'conversation' }, conversationId: id, background: true });
    }, context);
  };
  /** Checks after commits, one check at a time; commits during a check ask for one more, however many there were. */
  let checking = false, again = false;
  const schedule = async () => {
    again = true;
    if (checking) return;
    checking = true;
    while (again) {
      again = false;
      await resetIfIdle().catch(error => console.error(`OptChat could not reset the context: ${error instanceof Error ? error.message : String(error)}`));
    }
    checking = false;
  };

  const [zoom, date] = memoryTools(() => memory);
  const tools = [durableTool(zoom), durableTool(date), ...search ? [durableTool(searchTool(() => memory))] : []];
  const text = prompt ?? allowSearch(`${VIEW_DOC}${previousExchangeBytes ? CONTINUITY : ''}${search ? SEARCH_DOC : ''}`, search);

  return {
    extension: defineExtension({
      name: 'optchat',
      tools,
      sections: [section('optchat', () => text, { tag: false })],
      hooks: [hook(GenerationTask, { beforeRequest }), hook(CompactionTask, { beforeCompact: (_compaction, api) => api.conversationId === id ? { decline: true } : undefined })],
      tasks: [Remember],
    }),
    /** Starts following the conversation, and resets it now if a run ended before a restart. Returns a function that stops. */
    attach(opened: Harness, ctx: Context) {
      harness = opened; context = ctx;
      const stop = opened.subscribeCommits(() => void schedule());
      void schedule();
      return stop;
    },
  };
}

/** Pi Durable's `Models` with OptChat's cache marks on Anthropic requests that carry a view: in blocks of 4 lines, so a view that
 * grows at its end is read from the cache (pi-ai's own marks miss it). A request that sets its own `onPayload` is left alone, as
 * the compactor's are. A Proxy, since `createModels()` returns a class instance whose methods a spread would lose. */
export function withCacheMarks<M extends Models>(models: M): M {
  return new Proxy(models, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key, target);
      if (key !== 'streamSimple') return typeof value === 'function' ? value.bind(target) : value;
      const stream: Models['streamSimple'] = (model, request, options) => target.streamSimple(model, request,
        options?.onPayload || model.api !== 'anthropic-messages' ? options : { ...options, onPayload: payload => cachePayload(payload) });
      return stream;
    },
  });
}
