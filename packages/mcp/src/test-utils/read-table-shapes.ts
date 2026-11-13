import type { Database } from 'bun:sqlite';
import { z } from 'zod';

const ColumnSchema = z.object({
  name: z.string(),
  type: z.string(),
  notnull: z.number(),
  pk: z.number(),
});

const NameSchema = z.object({ name: z.string() });

// Each table's columns, foreign keys and indexes, so two databases compare
// by shape and not by the text of their CREATE statements, which quote
// names each in their own way.
export function readTableShapes(sqlite: Database) {
  const tables = sqlite
    .query(
      "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name",
    )
    .all()
    .map((row) => NameSchema.parse(row).name);

  return Object.fromEntries(
    tables.map((table) => [
      table,
      {
        columns: sqlite
          .query(`PRAGMA table_info("${table}")`)
          .all()
          .map((row) => ColumnSchema.parse(row)),
        keys: sqlite.query(`PRAGMA foreign_key_list("${table}")`).all(),
        indexes: sqlite
          .query(`PRAGMA index_list("${table}")`)
          .all()
          .map((row) => NameSchema.loose().parse(row))
          .map((row) => {
            const { seq: _seq, ...index } = row;

            return index;
          })
          .toSorted((left, right) => left.name.localeCompare(right.name)),
      },
    ]),
  );
}
