import { defineDoc, defineExtension, defineTask, ROOT_CONVERSATION_ID, type Harness, type TaskId } from '@earendil-works/pi-durable';
import type { SqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite';
import { chronological, deduplicate, isEntry, runImport, type ImportedEntry, type ImportMode, type Memory } from '../core/index.ts';
import { attachment, type Context } from './optchat.ts';
import { importTables, type Read } from './store.ts';

export type { ImportJob } from './store.ts';
/** How many new summaries the import builds between the progress it saves. Pi Durable ends a task that is cut off 5 times in a row
 * without saving progress (`settings.restartLimit`), which a long rebuild could otherwise be over a few deploys. */
const CHECKPOINT = 50;
/** The task that builds a generation. Pi Durable lists only live tasks, so this is how the one it ended is found. */
const ImportTask = defineDoc<{ generation: number | null; task: TaskId | null }>({
  kind: 'optchat.import.task', version: 1, scope: 'session', initial: () => ({ generation: null, task: null }), checkpointWhen: () => true,
});
/** Pi Durable ended the task because it was cut off `settings.restartLimit` times in a row. */
const cutOff = (failed: { detail?: unknown } | undefined) =>
  typeof failed?.detail === 'object' && failed.detail !== null && 'reason' in failed.detail && failed.detail.reason === 'restart_limit';

export interface ImportOptions {
  /** The live memory, as `optchat()` gets it. */
  memory: Memory;
  /** The database and synchronous read the live memory's `SqliteStore` was given. */
  db: SqliteDatabase;
  read: Read;
  /** Opens the memory an import builds, at `generation`: `openMemory(new SqliteStore(db, read, { ...options, generation }), compress,
   * { jobs: 4 })`. Fewer summaries at once than the live memory's 8, which keeps summarizing beside it, keep both under the model's rate limit. */
  open: (generation: number) => Promise<Memory>;
  /** Called once the import is live. Memory in RAM, and `optchat()`'s cursor, are still the old generation's: restart the object
   * (in a Durable Object, `ctx.abort()` once `ctx.storage.sync()` resolves, so the writes, and the responses waiting on them, go out first). */
  onActivated: () => void;
}

/** Imports history into a Pi Durable agent's memory: append adds it after the log, rebuild orders everything by date and summarizes
 * it all again. The import builds a new generation beside the live one, in a Pi Durable task that resumes after an eviction, while
 * the chat goes on with the old one; it switches in one transaction once the new one is complete. Install `extension` beside
 * `optchat()`'s and `attach` the opened Harness. Neither the plan nor the log's texts are held in RAM. */
export function optchatImport({ memory, db, read, open, onActivated }: ImportOptions) {
  const attached = attachment('OptChat import'), tables = importTables(db, read);
  /** The generation `memory` was opened at, read when first attached: once an import goes live, `memory` is the old one's until
   * the object restarts. */
  let opened: Promise<number> | undefined;
  /** The live tasks building `generation`'s import. */
  const tasks = async (generation: number) => (await attached.get().harness.inspect(attached.get().context)).tasks
    .filter(({ record: { kind, input } }) => kind === Import.definition.name && typeof input === 'object' && input !== null && !Array.isArray(input) && input.generation === generation);
  const createTask = (generation: number) => attached.get().harness.commit(async tx => {
    const task = await tx.createTask(Import, { generation }, { ownership: { kind: 'conversation' }, conversationId: ROOT_CONVERSATION_ID, background: true });
    Object.assign(await tx.doc(ImportTask), { generation, task });
  }, attached.get().context);
  /** Why `generation`'s task ended, when it threw or Pi Durable ended it; undefined while it lives, and when it never started. */
  const failure = async (generation: number) => {
    const { harness, context } = attached.get(), last = await harness.snapshot(ImportTask, context);
    if (last?.generation !== generation || last.task === null) return undefined;
    const state = (await harness.getTask(last.task, context))?.state;
    return state?.status === 'terminal' && state.outcome.status === 'faulted' ? state.outcome.error : undefined;
  };
  /** Starts the pending import's task, unless one is live. */
  const run = async () => { const { job } = await tables.state(); if (job && !(await tasks(job.generation)).length) await createTask(job.generation); };

  const Import = defineTask<{ generation: number }, { phase: 'import'; done: number }, null>({
    name: 'optchat.import', version: 1,
    initial: () => ({ phase: 'import', done: 0 }),
    phases: {
      // Cut off by an eviction, the phase runs again from the top, and `runImport` carries on from the new generation's log.
      import: async (task, runtime, ctx) => {
        const { job } = await tables.state();
        let activated = false, saving = Promise.resolve();
        // A task whose import was discarded, or went live, has nothing left to do.
        if (job?.generation === task.input.generation) await runImport({ entry: tables.planned, total: job.total, activate: async () => { await tables.activate(job.generation); activated = true; },
          open: async () => {
            const building = await open(job.generation);
            // From the progress last saved, so what earlier runs built before they were cut off counts too.
            let done = task.state.checkpoint.done;
            const checkpoint = () => {
              if (building.tree.size < done + CHECKPOINT) return;
              done = building.tree.size;
              saving = saving.then(() => runtime.commit(() => ({ status: 'running', checkpoint: { phase: 'import', done } }), ctx)).catch(() => {});
            };
            building.onChange(checkpoint); checkpoint();
            return building;
          } }, runtime.signal);
        await saving;
        // Once the switch is saved the old memory must go, even if this commit fails: nothing would call it later.
        try { await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: null } }), ctx); }
        finally { if (activated) onActivated(); }
      },
    },
    abort: (_task, runtime, ctx) => runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx),
  });

  return {
    extension: defineExtension({ name: 'optchat.import', tasks: [Import] }),
    /** Runs a pending import whose task is gone: it threw, or the object died before creating it. One that Pi Durable ended after
     * it was cut off again and again stays failed until `retry()`, since running it may be what stops the object. Returns a function that stops. */
    attach(harness: Harness, ctx: Context) {
      attached.set(harness, ctx);
      opened ??= tables.state().then(state => state.live);
      void (async () => { const { job } = await tables.state(); if (job && !cutOff(await failure(job.generation))) await run(); })()
        .catch(error => console.error(`OptChat could not resume the import: ${error instanceof Error ? error.message : String(error)}`));
      return attached.clear;
    },
    /** Plans an import of `incoming` and starts building it, with its counts; undefined when nothing in it is new. Refused for an
     * invalid entry, while another is pending, once memory failed a save, or after a switch until the object restarts. */
    async start(incoming: readonly ImportedEntry[], mode: ImportMode) {
      attached.get();
      if (!opened) throw new Error('OptChat import is not attached to a Harness yet.');
      const live = await opened;
      // Up front: a plan that fails later would stay pending, blocking every import after it.
      if (!incoming.every(e => isEntry({ ...e, i: 0 }))) throw new Error('Imported entry is invalid.');
      if (memory.saveError) throw new Error(`Memory could not be saved: ${memory.saveError}; restart before importing.`);
      // Planned from metadata; each text is read from memory as its plan row is written.
      const { added, skipped } = deduplicate(memory.root, incoming);
      if (!added.length) return undefined;
      const all = mode === 'rebuild' ? chronological([...memory.root, ...added]) : [...memory.root, ...chronological(added)];
      const plan = function* () { for (const [i, e] of all.entries()) yield 'text' in e ? { ...e, i } : { ...e, i, text: memory.text(e.i) }; };
      const job = await tables.stage(live, mode, plan(), mode === 'append' ? memory.root.length : 0);
      await createTask(job.generation);
      return { ...job, added: added.length, skipped };
    },
    /** The pending import, if any, with its live task's state (running, pending, or blocked by a version that cannot run it), or
     * with `failed`, the error that ended its task. `attach` starts a failed one again at the next restart, unless Pi Durable ended
     * it at its restart limit (`failed.detail` is `{ reason: 'restart_limit' }`): that one waits for `retry()` or `discard()`. */
    async pending() {
      const { job } = await tables.state();
      if (!job) return undefined;
      const task = (await tasks(job.generation))[0]?.state;
      return { ...job, task, failed: task ? undefined : await failure(job.generation) };
    },
    /** Runs the pending import again after it failed, from the progress it saved. */
    retry: run,
    /** Stops the pending import; the live memory is left as it is. One started meanwhile is left alone. */
    async discard() {
      const { job } = await tables.state();
      if (!job) return;
      for (const task of await tasks(job.generation)) await attached.get().harness.abortTask(task.record.id, attached.get().context);
      await tables.discard(job.generation);
    },
  };
}
