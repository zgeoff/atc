import type { Database } from 'bun:sqlite';
import { SqliteAdapter, SqliteIntrospector, SqliteQueryCompiler } from 'kysely';
import type { Dialect } from 'kysely';
import { BunSqliteDriver } from './bun-sqlite-driver';

export function buildSQLiteDialect(sqlite: Database): Dialect {
  return {
    createAdapter: () => new SqliteAdapter(),
    createDriver: () => new BunSqliteDriver(sqlite),
    createIntrospector: (kysely) => new SqliteIntrospector(kysely),
    createQueryCompiler: () => new SqliteQueryCompiler(),
  };
}
