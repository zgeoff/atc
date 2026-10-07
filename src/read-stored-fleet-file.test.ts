import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readStoredFleetFile } from './read-stored-fleet-file';

async function setupTest() {
  const dir = await mkdtemp(join(tmpdir(), 'read-stored-fleet-file-'));

  return {
    dbPath: join(dir, 'atc.db'),
    async [Symbol.asyncDispose]() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('it reads the rows this state directory owns with their exit status', async () => {
  await using fixture = await setupTest();

  const db = new Database(fixture.dbPath);

  db.run('CREATE TABLE fleet (session_id TEXT, name TEXT, exited INTEGER)');
  db.run('CREATE TABLE prefs (key TEXT, value TEXT)');
  db.run('CREATE TABLE session_owner (session_id TEXT, daemon_id TEXT)');
  db.run("INSERT INTO prefs VALUES ('daemon_id', 'd-1')");
  db.run("INSERT INTO fleet VALUES ('s-a', 'a', 0), ('s-b', 'b', 1), ('s-other', 'other', 0)");
  db.run("INSERT INTO session_owner VALUES ('s-a', 'd-1'), ('s-b', 'd-1'), ('s-other', 'd-2')");
  db.close();

  expect(readStoredFleetFile(fixture.dbPath)).toStrictEqual([
    { id: 's-a', name: 'a', exited: false },
    { id: 's-b', name: 'b', exited: true },
  ]);
});

test('it reads every row as live on a schema from before exit tracking and ownership', async () => {
  await using fixture = await setupTest();

  const db = new Database(fixture.dbPath);

  db.run('CREATE TABLE fleet (session_id TEXT, name TEXT)');
  db.run("INSERT INTO fleet VALUES ('s-a', 'a'), ('s-b', NULL)");
  db.close();

  expect(readStoredFleetFile(fixture.dbPath)).toStrictEqual([
    { id: 's-a', name: 'a', exited: false },
    { id: 's-b', name: 's-b', exited: false },
  ]);
});

test('it reads null for a missing database file', async () => {
  await using fixture = await setupTest();

  expect(readStoredFleetFile(fixture.dbPath)).toBeNull();
});

test('it reads null for a database without a fleet table', async () => {
  await using fixture = await setupTest();

  const db = new Database(fixture.dbPath);

  db.run('CREATE TABLE prefs (key TEXT, value TEXT)');
  db.close();

  expect(readStoredFleetFile(fixture.dbPath)).toBeNull();
});
