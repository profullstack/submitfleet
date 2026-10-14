import { createClient, type Client, type InArgs, type Row } from '@libsql/client';
import { MIGRATIONS } from './migrations.js';

export type Db = Client;

export interface OpenDbOptions {
  url: string;
  authToken?: string;
}

/** Opens a libSQL database (a local file or Turso) and applies forward-only migrations. */
export async function openDb(opts: OpenDbOptions): Promise<Db> {
  const db = createClient({ url: opts.url, authToken: opts.authToken });
  if (opts.url.startsWith('file:')) {
    await db.execute('PRAGMA journal_mode = WAL');
    await db.execute('PRAGMA busy_timeout = 5000');
  }
  await db.execute('PRAGMA foreign_keys = ON');
  await migrate(db);
  return db;
}

export async function migrate(db: Db): Promise<number> {
  await db.execute(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)',
  );
  const done = await db.execute('SELECT version FROM schema_migrations');
  const applied = new Set(done.rows.map((r) => Number(r.version)));
  let count = 0;
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    const stmts = m.sql
      .split(/;\s*$/m)
      .map((s) => s.trim())
      .filter(Boolean);
    await db.batch(
      [
        ...stmts,
        {
          sql: 'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
          args: [m.version, new Date().toISOString()],
        },
      ],
      'write',
    );
    count++;
  }
  return count;
}

// libSQL rejects `undefined` on the remote client but binds it as null locally,
// so normalise every argument list before it leaves this module.
function clean(args: unknown[]): InArgs {
  return args.map((a) => (a === undefined ? null : a)) as InArgs;
}

export async function all<T = Row>(db: Db, sql: string, ...args: unknown[]): Promise<T[]> {
  const r = await db.execute({ sql, args: clean(args) });
  return r.rows as unknown as T[];
}

export async function one<T = Row>(db: Db, sql: string, ...args: unknown[]): Promise<T | null> {
  const rows = await all<T>(db, sql, ...args);
  return rows[0] ?? null;
}

export async function run(db: Db, sql: string, ...args: unknown[]): Promise<number> {
  const r = await db.execute({ sql, args: clean(args) });
  return r.rowsAffected;
}
