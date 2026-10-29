import type { SqliteDatabase, SqliteValue } from '@earendil-works/pi-durable/storage/sqlite';
import { isMime, type Entry, type Mime, type Part, type Saved, type Store, type Summary } from '../core/index.ts';

/** A Durable Object's SQLite refuses a row over 2 MB. A message's text is stored in parts of at most this many UTF-16 units,
 * so a part is at most ~1.5 MB of UTF-8 however the text is written, and a huge pasted email still fits. */
const PART = 512 * 1024;

const TABLES = `CREATE TABLE IF NOT EXISTS optchat_log (i INTEGER NOT NULL, part INTEGER NOT NULL, meta TEXT, text TEXT NOT NULL, PRIMARY KEY (i, part));
CREATE TABLE IF NOT EXISTS optchat_tree (l INTEGER NOT NULL, i INTEGER NOT NULL, size INTEGER NOT NULL, text TEXT NOT NULL, PRIMARY KEY (l, i));
CREATE TABLE IF NOT EXISTS optchat_view (id INTEGER PRIMARY KEY CHECK (id = 0), json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS optchat_images (name TEXT PRIMARY KEY, mime TEXT NOT NULL, data BLOB NOT NULL);`;

/** Splits `text` every PART units, never between the two halves of a surrogate pair. An empty text is one empty part. */
function parts(text: string) {
  const result: string[] = [];
  for (let at = 0; at < text.length || !result.length;) {
    let end = Math.min(text.length, at + PART);
    if (end < text.length && /[\ud800-\udbff]/.test(text[end - 1])) end--;
    result.push(text.slice(at, end)); at = end;
  }
  return result;
}

/** A synchronous query on the same database, for the texts memory reads while it builds a view, zooms or searches. In a Durable
 * Object: `(sql, ...params) => ctx.storage.sql.exec(sql, ...params)`; on Node, node:sqlite's `(sql, ...params) => db.prepare(sql).iterate(...params)`. */
export type Read = (sql: string, ...params: SqliteValue[]) => Iterable<Record<string, unknown>>;
const texts = (rows: Iterable<Record<string, unknown>>) => [...rows].map(row => typeof row.text === 'string' ? row.text : '').join('');

/** OptChat's memory in any Chord `SqliteDatabase`, such as Node's (`NodeSqliteDatabase`) or a Durable Object's. Give it the
 * database Pi Durable's storage uses, so both share one queue: in a Durable Object, the `DurableObjectSqliteDatabase` over
 * `ctx.storage` (direct `ctx.storage.sql` writes could be rolled back with a Pi transaction). `read` reads texts from the same
 * database synchronously; it only reads rows whose writes have finished, so it needs no queue. Its tables are `optchat_*`, beside
 * Pi's `pi_*`. Memory loads only metadata and node sizes; texts stay here. Messages are split so no row passes a Durable Object's
 * 2 MB limit; images must be under 2 MB each. */
export class SqliteStore implements Store {
  constructor(private readonly db: SqliteDatabase, private readonly read: Read) {}
  async load(): Promise<Saved> {
    await this.db.exec(TABLES);
    const log = await this.db.all<{ meta: string }>('SELECT meta FROM optchat_log WHERE part = 0 ORDER BY i');
    const tree = await this.db.all<{ l: number; i: number; size: number }>('SELECT l, i, size FROM optchat_tree');
    const view = await this.db.get<{ json: string }>('SELECT json FROM optchat_view');
    return { entries: log.map(row => JSON.parse(row.meta)), tree, view: view?.json };
  }
  text(i: number) { return texts(this.read('SELECT text FROM optchat_log WHERE i = ? ORDER BY part', i)); }
  summary({ l, i }: Part) { return texts(this.read('SELECT text FROM optchat_tree WHERE l = ? AND i = ?', l, i)); }
  /** The primary key refuses a second message at an index, so a store that was not the last to append writes nothing. */
  async append(entry: Entry) {
    try {
      await this.db.transaction(async tx => {
        const { text, ...meta } = entry;
        for (const [part, chunk] of parts(text).entries())
          await tx.run('INSERT INTO optchat_log (i, part, meta, text) VALUES (?, ?, ?, ?)', entry.i, part, part ? null : JSON.stringify(meta), chunk);
      });
    } catch (error) {
      if (await this.db.get('SELECT 1 FROM optchat_log WHERE i = ? AND part = 0', entry.i))
        throw new Error(`Someone else already saved message ${entry.i}; nothing was written.`, { cause: error });
      throw error;
    }
  }
  async appendNode(node: Summary) {
    await this.db.run('INSERT OR REPLACE INTO optchat_tree (l, i, size, text) VALUES (?, ?, ?, ?)', node.l, node.i, node.size, node.text);
  }
  async saveView(view: string) {
    await this.db.run('INSERT OR REPLACE INTO optchat_view (id, json) VALUES (0, ?)', view);
  }
  async putImage(name: string, mimeType: Mime, data: Uint8Array) {
    await this.db.run('INSERT OR REPLACE INTO optchat_images (name, mime, data) VALUES (?, ?, ?)', name, mimeType, data);
  }
  async image(name: string) {
    const row = await this.db.get<{ mime: string; data: Uint8Array }>('SELECT mime, data FROM optchat_images WHERE name = ?', name);
    return row && isMime(row.mime) ? { mimeType: row.mime, data: row.data } : undefined;
  }
}
