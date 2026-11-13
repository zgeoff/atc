import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { registerTestCleanup } from '@atc/test-utils';
import { readTableShapes } from './read-table-shapes';

function setupTest() {
  const sqlite = new Database(':memory:');

  registerTestCleanup(() => {
    sqlite.close();
  });

  return { sqlite };
}

test('it reads each table with its columns, foreign keys and indexes', () => {
  const ctx = setupTest();

  ctx.sqlite.run('create table parent (id text primary key not null)');

  ctx.sqlite.run(
    'create table child (id text, parent_id text references parent (id) on delete cascade)',
  );

  ctx.sqlite.run('create index child_parent_idx on child (parent_id)');

  expect(readTableShapes(ctx.sqlite)).toStrictEqual({
    child: {
      columns: [
        { name: 'id', type: 'TEXT', notnull: 0, pk: 0 },
        { name: 'parent_id', type: 'TEXT', notnull: 0, pk: 0 },
      ],
      keys: [expect.objectContaining({ table: 'parent', from: 'parent_id', on_delete: 'CASCADE' })],
      indexes: [{ name: 'child_parent_idx', unique: 0, origin: 'c', partial: 0 }],
    },
    parent: {
      columns: [{ name: 'id', type: 'TEXT', notnull: 1, pk: 1 }],
      keys: [],
      indexes: [{ name: 'sqlite_autoindex_parent_1', unique: 1, origin: 'pk', partial: 0 }],
    },
  });
});
