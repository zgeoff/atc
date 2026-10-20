import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { StateStoreSchema } from './state-store-schema';

const COLUMN_NAME_ROWS_SCHEMA = z.array(z.object({ name: z.string() }));

export async function readTableColumns(
  db: Kysely<StateStoreSchema>,
  table: string,
): Promise<ReadonlySet<string>> {
  const result = await sql`PRAGMA table_info(${sql.id(table)})`.execute(db);

  return new Set(COLUMN_NAME_ROWS_SCHEMA.parse(result.rows).map((row) => row.name));
}
