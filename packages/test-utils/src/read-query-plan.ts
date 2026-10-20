import { Database } from 'bun:sqlite';
import { isSQLQueryBinding } from '@zgeoff/kysely-bun-sqlite';
import type { CompiledQuery } from 'kysely';
import { z } from 'zod';

const PLAN_ROWS_SCHEMA = z.array(z.object({ detail: z.string() }));

export function readQueryPlan(dbPath: string, query: CompiledQuery): string {
  const bindings = query.parameters.map((parameter) => {
    if (!isSQLQueryBinding(parameter)) {
      throw new TypeError('bun:sqlite cannot bind a query parameter');
    }

    return parameter;
  });

  const db = new Database(dbPath, { readonly: true });

  try {
    const rows = db.query(`EXPLAIN QUERY PLAN ${query.sql}`).all(...bindings);

    return PLAN_ROWS_SCHEMA.parse(rows)
      .map((row) => row.detail)
      .join('\n');
  } finally {
    db.close();
  }
}
