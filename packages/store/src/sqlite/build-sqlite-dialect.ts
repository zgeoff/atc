import type { Database } from 'bun:sqlite';
import { SqliteAdapter, SqliteIntrospector, SqliteQueryCompiler } from 'kysely';
import type { Dialect } from 'kysely';
import { BunSqliteDriver } from './bun-sqlite-driver';

/**
 * The Kysely dialect over one open bun:sqlite handle: Kysely's SQLite
 * adapter, introspector, and compiler with atc's driver. Closing the handle
 * stays with the caller that opened it.
 */
export function buildSQLiteDialect(sqlite: Database): Dialect {
  return {
    createAdapter: () => new SqliteAdapter(),
    createDriver: () => new BunSqliteDriver(sqlite),
    createIntrospector: (kysely) => new SqliteIntrospector(kysely),
    createQueryCompiler: () => new SqliteQueryCompiler(),
  };
}
