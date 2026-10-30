import { defineExtension, defineTask, ROOT_CONVERSATION_ID, type Harness } from '@earendil-works/pi-durable';
import type { SqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite';
import { chronological, deduplicate, runImport, type ImportedEntry, type ImportMode, type Memory } from '../core/index.ts';
import { attachment, type Context } from './optchat.ts';
import { importTables, type Read } from './store.ts';

export type { ImportJob } from './store.ts';
/** How many new summaries the import builds between the progress it saves. Pi Durable parks a task that restarts 5 times without
 * saving progress, which a long rebuild could otherwise do over a few deploys. */
const CHECKPOINT = 50;

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
   * (in a Durable Object, `ctx.abort()`). */
  onActivated: () => void;
}

/** Imports history into a Pi Durable agent's memory: append adds it after the log, rebuild orders everything by date and summarizes
 * it all again. The import builds a new generation beside the live one, in a Pi Durable task that resumes after an eviction, while
 * the chat goes on with the old one; it switches in one transaction once the new one is complete. Install `extension` beside
 * `optchat()`'s and `attach` the opened Harness. Neither the plan nor the log's texts are held in RAM. */
export function optchatImport({ memory, db, read, open, onActivated }: ImportOptions) {
  const attached = attachment('OptChat import'), tables = importTables(db, read);
  /** Set once an import went live: `memory` is the old generation's until the object restarts. */
  let switched = false;
  const tasks = async () => (await attached.get().harness.inspect(attached.get().context)).tasks.filter(task => task.record.kind === Import.definition.name);
  const createTask = () => attached.get().harness.commit(tx => tx.createTask(Import, {},
    { ownership: { kind: 'conversation' }, conversationId: ROOT_CONVERSATION_ID, background: true }), attached.get().context);

  const Import = defineTask<Record<string, never>, { phase: 'import'; done: number }, null>({
    name: 'optchat.import', version: 1,
    initial: () => ({ phase: 'import', done: 0 }),
    phases: {
      // Cut off by an eviction, the phase runs again from the top, and `runImport` carries on from the new generation's log.
      import: async (_task, runtime, ctx) => {
        const { job } = await tables.state();
        let activated = false, saving = Promise.resolve();
        if (job) await runImport({ entry: tables.planned, total: job.total, activate: async () => { await tables.activate(job.generation); activated = switched = true; },
          open: async () => {
            const building = await open(job.generation);
            let done = building.tree.size;
            building.onChange(() => {
              if (building.tree.size < done + CHECKPOINT) return;
              done = building.tree.size;
              saving = saving.then(() => runtime.commit(() => ({ status: 'running', checkpoint: { phase: 'import', done } }), ctx)).catch(() => {});
            });
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
    /** Runs a pending import whose task is gone: it failed, or the object died before creating it. Returns a function that stops. */
    attach(harness: Harness, ctx: Context) {
      attached.set(harness, ctx);
      void (async () => { if ((await tables.state()).job && !(await tasks()).length) await createTask(); })()
        .catch(error => console.error(`OptChat could not resume the import: ${error instanceof Error ? error.message : String(error)}`));
      return attached.clear;
    },
    /** Plans an import of `incoming` and starts building it, with its counts; undefined when nothing in it is new. Refused while
     * another is pending, once memory failed a save, or after a switch until the object restarts. */
    async start(incoming: readonly ImportedEntry[], mode: ImportMode) {
      attached.get();
      if (switched) throw new Error('An import went live: restart before the next one.');
      if (memory.saveError) throw new Error(`Memory could not be saved: ${memory.saveError}; restart before importing.`);
      // Planned from metadata; each text is read from memory as its plan row is written.
      const { added, skipped } = deduplicate(memory.root, incoming);
      if (!added.length) return undefined;
      const all = mode === 'rebuild' ? chronological([...memory.root, ...added]) : [...memory.root, ...chronological(added)];
      const plan = function* () { for (const [i, e] of all.entries()) yield 'text' in e ? { ...e, i } : { ...e, i, text: memory.text(e.i) }; };
      const job = await tables.stage(mode, plan(), mode === 'append' ? memory.root.length : 0);
      await createTask();
      return { ...job, added: added.length, skipped };
    },
    /** The pending import, if any, with its task's state: running, ready, or blocked (parked after restarts: `harness.retryTask`).
     * No task means it failed; `attach` starts it again at the next restart. */
    async pending() {
      const { job } = await tables.state();
      return job && { ...job, task: (await tasks())[0]?.state };
    },
    /** Stops a pending import; the live memory is left as it is. */
    async discard() {
      for (const task of await tasks()) await attached.get().harness.abortTask(task.record.id, attached.get().context);
      await tables.discard();
    },
  };
}
