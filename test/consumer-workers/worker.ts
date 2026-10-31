import { DurableObjectSqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite/cloudflare';
import { openMemory, type Compressor } from 'pi-optchat/core';
import { optchat, optchatImport, SqliteStore, type Read } from 'pi-optchat/durable';

export async function open(storage: DurableObjectStorage, compress: Compressor) {
  const db = new DurableObjectSqliteDatabase(storage), read: Read = (sql, ...params) => storage.sql.exec(sql, ...params);
  const memory = await openMemory(new SqliteStore(db, read), compress, { budget: 16_000 });
  const importer = optchatImport({ memory, db, read, onActivated: () => {},
    open: generation => openMemory(new SqliteStore(db, read, { generation }), compress, { jobs: 4 }) });
  return { memory, importer, extension: optchat({ memory, refreshAt: 0.3 }) };
}
