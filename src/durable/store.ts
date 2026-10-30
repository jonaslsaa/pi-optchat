import type { SqliteDatabase, SqliteExecutor, SqliteValue } from '@earendil-works/pi-durable/storage/sqlite';
import { isMime, type Entry, type ImageStore, type ImportMode, type Mime, type Part, type Saved, type Store, type Summary } from '../core/index.ts';

/** A Durable Object's SQLite refuses a row over 2 MB. A message's text is stored as JSON in parts of at most this many UTF-16 units,
 * so a part is at most ~1.5 MB of UTF-8 however the text is written, and a huge pasted email still fits. */
const PART = 512 * 1024;
export interface SqliteStoreOptions {
  /** Where images are kept instead of `optchat_images`, such as an R2 bucket that keeps large binary data out of the database
   * (its row size limit and storage cost). */
  images?: ImageStore;
  /** The generation to open, as `optchatImport` does for the one it builds. Default: the live one, whose load also deletes the
   * rows of generations that are neither live nor being imported. */
  generation?: number;
}

/** Log, tree and view rows carry their generation `g`: an import builds a new one beside the live one. `optchat_state` names the
 * live one, the pending import's (`target`, NULL when none) and the last one handed out; the planned log is in `optchat_plan`.
 * Images are shared. */
const TABLES = `CREATE TABLE IF NOT EXISTS optchat_log (g INTEGER NOT NULL, i INTEGER NOT NULL, part INTEGER NOT NULL, meta TEXT, text TEXT NOT NULL, PRIMARY KEY (g, i, part));
CREATE TABLE IF NOT EXISTS optchat_tree (g INTEGER NOT NULL, l INTEGER NOT NULL, i INTEGER NOT NULL, size INTEGER NOT NULL, text TEXT NOT NULL, PRIMARY KEY (g, l, i));
CREATE TABLE IF NOT EXISTS optchat_view (g INTEGER PRIMARY KEY, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS optchat_images (name TEXT PRIMARY KEY, mime TEXT NOT NULL, data BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS optchat_state (id INTEGER PRIMARY KEY CHECK (id = 0), live INTEGER NOT NULL, last INTEGER NOT NULL DEFAULT 0, target INTEGER, mode TEXT, total INTEGER);
CREATE TABLE IF NOT EXISTS optchat_plan (i INTEGER NOT NULL, part INTEGER NOT NULL, meta TEXT, text TEXT NOT NULL, PRIMARY KEY (i, part));
INSERT OR IGNORE INTO optchat_state (id, live) VALUES (0, 0);`;

/** Splits `text` every PART units, never between the two halves of a surrogate pair. */
function parts(text: string) {
  const result: string[] = [];
  for (let at = 0; at < text.length;) {
    let end = Math.min(text.length, at + PART);
    if (end < text.length && /[\ud800-\udbff]/.test(text[end - 1])) end--;
    result.push(text.slice(at, end)); at = end;
  }
  return result;
}
/** An entry as rows of `(part, meta, text)`: its text as JSON in parts, its metadata on the first. */
const rows = ({ text, ...meta }: Entry) => parts(JSON.stringify(text)).map((chunk, part) => [part, part ? null : JSON.stringify(meta), chunk] as const);

/** A synchronous query on the same database, for the texts memory reads while it builds a view, zooms or searches. In a Durable
 * Object: `(sql, ...params) => ctx.storage.sql.exec(sql, ...params)`; on Node, node:sqlite's `(sql, ...params) => db.prepare(sql).iterate(...params)`. */
export type Read = (sql: string, ...params: SqliteValue[]) => Iterable<Record<string, unknown>>;
/** Texts are stored as JSON, which keeps an unpaired surrogate that SQLite's TEXT would replace. A text that isn't there throws. */
function texts(rows: Iterable<Record<string, unknown>>, what: string) {
  const found = [...rows].map(row => typeof row.text === 'string' ? row.text : '');
  if (!found.length) throw new Error(`No ${what} in this store.`);
  const text: unknown = JSON.parse(found.join(''));
  if (typeof text !== 'string') throw new Error(`Invalid ${what} in this store.`);
  return text;
}

/** OptChat's memory in any Chord `SqliteDatabase`, such as Node's (`NodeSqliteDatabase`) or a Durable Object's. Give it the
 * database Pi Durable's storage uses, so both share one queue: in a Durable Object, the `DurableObjectSqliteDatabase` over
 * `ctx.storage` (direct `ctx.storage.sql` writes could be rolled back with a Pi transaction). `read` reads texts from the same
 * database synchronously; it only reads rows whose writes have finished, so it needs no queue. Its tables are `optchat_*`, beside
 * Pi's `pi_*`. Memory loads only metadata and node sizes; texts stay here. Messages are split so no row passes a Durable Object's
 * 2 MB limit; images go to `images` when given, otherwise to `optchat_images`, one row each. */
export class SqliteStore implements Store {
  #g = 0;
  constructor(private readonly db: SqliteDatabase, private readonly read: Read, private readonly options: SqliteStoreOptions = {}) {}
  async load(): Promise<Saved> {
    await this.db.exec(TABLES);
    if (this.options.generation !== undefined) this.#g = this.options.generation;
    else {
      const state = await this.db.get<{ live: number; target: number | null }>('SELECT live, target FROM optchat_state');
      this.#g = state?.live ?? 0;
      // An old memory may still write to its generation until the object restarts after a switch, so old rows go only here.
      await this.db.transaction(async tx => {
        for (const table of ['log', 'tree', 'view']) await tx.run(`DELETE FROM optchat_${table} WHERE g NOT IN (?, ?)`, this.#g, state?.target ?? this.#g);
      });
    }
    const log = await this.db.all<{ meta: string }>('SELECT meta FROM optchat_log WHERE g = ? AND part = 0 ORDER BY i', this.#g);
    const tree = await this.db.all<{ l: number; i: number; size: number }>('SELECT l, i, size FROM optchat_tree WHERE g = ?', this.#g);
    const view = await this.db.get<{ json: string }>('SELECT json FROM optchat_view WHERE g = ?', this.#g);
    return { entries: log.map(row => JSON.parse(row.meta)), tree, view: view?.json };
  }
  text(i: number) { return texts(this.read('SELECT text FROM optchat_log WHERE g = ? AND i = ? ORDER BY part', this.#g, i), `message ${i}`); }
  summary({ l, i }: Part) { return texts(this.read('SELECT text FROM optchat_tree WHERE g = ? AND l = ? AND i = ?', this.#g, l, i), `summary ${l}/${i}`); }
  /** The primary key refuses a second message at an index, so a store that was not the last to append writes nothing. */
  async append(entry: Entry) {
    try {
      await this.db.transaction(async tx => {
        for (const row of rows(entry)) await tx.run('INSERT INTO optchat_log (g, i, part, meta, text) VALUES (?, ?, ?, ?, ?)', this.#g, entry.i, ...row);
      });
    } catch (error) {
      if (await this.db.get('SELECT 1 FROM optchat_log WHERE g = ? AND i = ? AND part = 0', this.#g, entry.i))
        throw new Error(`Someone else already saved message ${entry.i}; nothing was written.`, { cause: error });
      throw error;
    }
  }
  async appendNode(node: Summary) {
    await this.db.run('INSERT OR REPLACE INTO optchat_tree (g, l, i, size, text) VALUES (?, ?, ?, ?, ?)', this.#g, node.l, node.i, node.size, JSON.stringify(node.text));
  }
  async saveView(view: string) {
    await this.db.run('INSERT OR REPLACE INTO optchat_view (g, json) VALUES (?, ?)', this.#g, view);
  }
  async putImage(name: string, mimeType: Mime, data: Uint8Array) {
    if (this.options.images) return this.options.images.putImage(name, mimeType, data);
    await this.db.run('INSERT OR REPLACE INTO optchat_images (name, mime, data) VALUES (?, ?, ?)', name, mimeType, data);
  }
  async image(name: string) {
    if (this.options.images) return this.options.images.image(name);
    const row = await this.db.get<{ mime: string; data: Uint8Array }>('SELECT mime, data FROM optchat_images WHERE name = ?', name);
    return row && isMime(row.mime) ? { mimeType: row.mime, data: row.data } : undefined;
  }
}

/** A pending import: the generation it builds, and its plan's mode and length. */
export interface ImportJob { generation: number; mode: ImportMode; total: number }

/** The rows `optchatImport` keeps: which generation is live, the pending import and its plan. */
export function importTables(db: SqliteDatabase, read: Read) {
  const state = async (tx: SqliteExecutor = db) => {
    await tx.exec(TABLES);
    const row = await tx.get<{ live: number; target: number | null; mode: ImportMode | null; total: number | null }>('SELECT live, target, mode, total FROM optchat_state');
    const job: ImportJob | undefined = row?.target != null && row.mode && row.total != null ? { generation: row.target, mode: row.mode, total: row.total } : undefined;
    return { live: row?.live ?? 0, job };
  };
  return {
    state: () => state(),
    /** Saves the plan, `entries` in order, made from generation `from`, and makes it the pending import of a new generation. A
     * generation is never handed out twice, so a late call about a discarded one can't touch the next. Append's new generation starts with the live one's first `kept` messages, the nodes
     * over them, and its view. Refused unless `from` is still live: an import went live since. */
    stage: (from: number, mode: ImportMode, entries: Iterable<Entry>, kept: number) => db.transaction(async tx => {
      const { live, job } = await state(tx);
      if (job) throw new Error('An import is pending: let it finish, or discard it.');
      if (live !== from) throw new Error('An import went live: restart before the next one.');
      const generation = ((await tx.get<{ last: number }>('SELECT last FROM optchat_state'))?.last ?? live) + 1;
      await tx.run('DELETE FROM optchat_plan');
      let total = 0;
      for (const entry of entries) { total++; for (const row of rows(entry)) await tx.run('INSERT INTO optchat_plan (i, part, meta, text) VALUES (?, ?, ?, ?)', entry.i, ...row); }
      if (kept) {
        // Nodes only over the messages copied: a message still being written isn't, and a node past the log would refuse to open.
        // The view keeps its cached prefix; one that covers more than was copied is rebuilt.
        await tx.run('INSERT INTO optchat_log (g, i, part, meta, text) SELECT ?, i, part, meta, text FROM optchat_log WHERE g = ? AND i < ?', generation, live, kept);
        await tx.run(`INSERT INTO optchat_tree (g, l, i, size, text) SELECT ?, l, i, size, text FROM optchat_tree
          WHERE g = ? AND ((i + 1) << l) <= (SELECT COUNT(*) FROM optchat_log WHERE g = ? AND part = 0)`, generation, live, generation);
        await tx.run('INSERT INTO optchat_view (g, json) SELECT ?, json FROM optchat_view WHERE g = ?', generation, live);
      }
      await tx.run('UPDATE optchat_state SET last = ?, target = ?, mode = ?, total = ?', generation, generation, mode, total);
      return { generation, mode, total };
    }),
    /** Planned message `i`, as saved; validated where it is used. */
    planned(i: number): unknown {
      const [first] = read('SELECT meta FROM optchat_plan WHERE i = ? AND part = 0', i);
      if (typeof first?.meta !== 'string') throw new Error(`No planned message ${i} in this store.`);
      return { ...JSON.parse(first.meta), text: texts(read('SELECT text FROM optchat_plan WHERE i = ? ORDER BY part', i), `planned message ${i}`) };
    },
    /** Makes `generation` live and drops its plan, in one transaction; refused if its import was discarded meanwhile. */
    activate: (generation: number) => db.transaction(async tx => {
      if ((await state(tx)).job?.generation !== generation) throw new Error('The import was discarded.');
      await tx.run('UPDATE optchat_state SET live = target, target = NULL, mode = NULL, total = NULL');
      await tx.run('DELETE FROM optchat_plan');
    }),
    /** Drops the pending import if it is still `generation`'s; its rows go when the live store next loads. */
    discard: (generation: number) => db.transaction(async tx => {
      if ((await state(tx)).job?.generation !== generation) return;
      await tx.run('UPDATE optchat_state SET target = NULL, mode = NULL, total = NULL');
      await tx.run('DELETE FROM optchat_plan');
    }),
  };
}
