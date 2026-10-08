import { Database } from 'bun:sqlite';
import type { SQLQueryBindings } from 'bun:sqlite';
import type { CompiledQuery } from 'kysely';

/**
 * Reads the plan SQLite picks for one compiled query against the database
 * at the path, bound to the query's own parameters, as the plan's detail
 * lines joined by newlines. It opens the database read-only and closes it
 * before returning, so the query never runs and nothing is written.
 */
export function readQueryPlan(dbPath: string, query: CompiledQuery): string {
  const db = new Database(dbPath, { readonly: true });

  // oxlint-disable-next-line no-unsafe-type-assertion -- kysely's sqlite compiler only ever binds bun:sqlite-legal values
  const bindings = query.parameters as SQLQueryBindings[];

  try {
    return db
      .query<{ detail: string }, SQLQueryBindings[]>(`EXPLAIN QUERY PLAN ${query.sql}`)
      .all(...bindings)
      .map((row) => row.detail)
      .join('\n');
  } finally {
    db.close();
  }
}
