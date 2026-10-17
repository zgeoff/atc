import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import type { StateStoreSchema } from './state-store-schema';

export interface ColumnInfoRow {
  name: string;
  type: string;
}

export async function collectFleetColumns(
  db: Kysely<StateStoreSchema>,
): Promise<ReadonlySet<string>> {
  const result = await sql<ColumnInfoRow>`PRAGMA table_info(fleet)`.execute(db);

  return new Set(result.rows.map((row) => row.name));
}
