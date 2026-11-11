import { expect, onTestFinished, test } from 'bun:test';
import { join } from 'node:path';
import { setupTempDir } from '@atc/test-utils';
import { openTestBindingDatabase } from './open-test-binding-database';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-test-binding-db-');

  return { path: join(temporaryDirectory.path, 'gateway.db') };
}

test('it binds a named parameter given without its prefix', () => {
  const ctx = setupTest();
  const db = openTestBindingDatabase(ctx.path);

  onTestFinished(() => {
    db.close();
  });

  db.run('CREATE TABLE note (id TEXT)');
  db.query('INSERT INTO note (id) VALUES ($id)').run({ id: 'n1' });

  expect(db.query('SELECT id FROM note WHERE id = $id').get({ id: 'n1' })).toStrictEqual({
    id: 'n1',
  });
});

test('it opens the file in WAL mode', () => {
  const ctx = setupTest();
  const db = openTestBindingDatabase(ctx.path);

  onTestFinished(() => {
    db.close();
  });

  expect(db.query('PRAGMA journal_mode').get({})).toStrictEqual({ journal_mode: 'wal' });
});
