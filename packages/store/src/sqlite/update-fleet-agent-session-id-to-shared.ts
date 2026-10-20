import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import type { ColumnInfoRow } from './read-fleet-columns';
import type { StateStoreSchema } from './state-store-schema';

interface FullColumnInfoRow extends ColumnInfoRow {
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

// Rebuilds the fleet with every column it carries, under the same types,
// defaults, and key, but without the unique agent session id, so live
// sessions on two targets that resume one agent session keep a row each.
export async function updateFleetAgentSessionIDToShared(
  db: Kysely<StateStoreSchema>,
): Promise<void> {
  const columns = await sql<FullColumnInfoRow>`PRAGMA table_info(fleet)`.execute(db);

  const definitions = columns.rows.map((column) => {
    const notNull = column.notnull === 1 ? ' NOT NULL' : '';
    const fallback = column.dflt_value === null ? '' : ` DEFAULT ${column.dflt_value}`;
    const key = column.pk === 1 ? ' PRIMARY KEY' : '';

    return sql`${sql.ref(column.name)} ${sql.raw(`${column.type}${notNull}${fallback}${key}`)}`;
  });

  const names = columns.rows.map((column) => sql.ref(column.name));

  await sql`CREATE TABLE fleet_rebuilt (${sql.join(definitions)})`.execute(db);

  await sql`INSERT INTO fleet_rebuilt (${sql.join(names)}) SELECT ${sql.join(names)} FROM fleet`.execute(
    db,
  );

  await sql`DROP TABLE fleet`.execute(db);
  await sql`ALTER TABLE fleet_rebuilt RENAME TO fleet`.execute(db);
}
