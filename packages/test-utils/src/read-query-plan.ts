import { Database } from 'bun:sqlite';
import type { SQLQueryBindings } from 'bun:sqlite';
import type { CompiledQuery } from 'kysely';

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
