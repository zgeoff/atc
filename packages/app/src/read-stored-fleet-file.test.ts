import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { readStoredFleetFile } from './read-stored-fleet-file';
import { registerTestCleanup } from './test-utils/register-test-cleanup';
import { setupTempDir } from './test-utils/setup-temp-dir';

/**
 * A path for the state database in a fresh temp directory, which each test
 * fills or leaves missing. The directory goes once the test finishes.
 */
function setupTest() {
  const tmp = setupTempDir('read-stored-fleet-file-');

  return { dbPath: join(tmp.dir, 'atc.db') };
}

test('it reads the rows this state directory owns with their exit status', () => {
  const ctx = setupTest();

  const db = new Database(ctx.dbPath);

  registerTestCleanup(() => {
    db.close();
  });

  db.run('CREATE TABLE fleet (session_id TEXT, name TEXT, exited INTEGER)');
  db.run('CREATE TABLE prefs (key TEXT, value TEXT)');
  db.run('CREATE TABLE session_owner (session_id TEXT, daemon_id TEXT)');
  db.run("INSERT INTO prefs VALUES ('daemon_id', 'd-1')");
  db.run("INSERT INTO fleet VALUES ('s-a', 'a', 0), ('s-b', 'b', 1), ('s-other', 'other', 0)");
  db.run("INSERT INTO session_owner VALUES ('s-a', 'd-1'), ('s-b', 'd-1'), ('s-other', 'd-2')");

  expect(readStoredFleetFile(ctx.dbPath)).toStrictEqual([
    { id: 's-a', name: 'a', exited: false, agentSessionID: null },
    { id: 's-b', name: 'b', exited: true, agentSessionID: null },
  ]);
});

test('it reads rows keyed by the agent session id on a schema from before atc session ids', () => {
  const ctx = setupTest();

  const db = new Database(ctx.dbPath);

  registerTestCleanup(() => {
    db.close();
  });

  db.run('CREATE TABLE fleet (agent_session_id TEXT, name TEXT, cwd TEXT, exited INTEGER)');
  db.run("INSERT INTO fleet VALUES ('a-a', 'a', '/tmp', 0), ('a-b', NULL, '/tmp', 1)");

  expect(readStoredFleetFile(ctx.dbPath)).toStrictEqual([
    { id: 'a-a', name: 'a', exited: false, agentSessionID: 'a-a' },
    { id: 'a-b', name: 'a-b', exited: true, agentSessionID: 'a-b' },
  ]);
});

test('it reads every row as live on the first schema, keyed by the claude id', () => {
  const ctx = setupTest();

  const db = new Database(ctx.dbPath);

  registerTestCleanup(() => {
    db.close();
  });

  db.run('CREATE TABLE fleet (claude_id TEXT PRIMARY KEY, name TEXT NOT NULL, cwd TEXT NOT NULL)');
  db.run("INSERT INTO fleet VALUES ('c-a', 'a', '/tmp')");

  expect(readStoredFleetFile(ctx.dbPath)).toStrictEqual([
    { id: 'c-a', name: 'a', exited: false, agentSessionID: 'c-a' },
  ]);
});

test('it reads null for a missing database file', () => {
  const ctx = setupTest();

  expect(readStoredFleetFile(ctx.dbPath)).toBeNull();
});

test('it reads null for a database without a fleet table', () => {
  const ctx = setupTest();

  const db = new Database(ctx.dbPath);

  registerTestCleanup(() => {
    db.close();
  });

  db.run('CREATE TABLE prefs (key TEXT, value TEXT)');

  expect(readStoredFleetFile(ctx.dbPath)).toBeNull();
});
