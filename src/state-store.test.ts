import { Database } from 'bun:sqlite';
import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from './state-store';

function setupDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'atc-store-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  return dir;
}

test('it round-trips the fleet', () => {
  const store = new StateStore(join(setupDir(), 'state.db'));

  onTestFinished(() => {
    store.stop();
  });

  store.writeFleet([
    { name: 'auth-bug', cwd: '/x', claudeId: 'c1' },
    { name: 'refactor', cwd: '/y', claudeId: 'c2' },
  ]);

  expect(store.loadFleet()).toStrictEqual([
    { name: 'auth-bug', cwd: '/x', claudeId: 'c1' },
    { name: 'refactor', cwd: '/y', claudeId: 'c2' },
  ]);
});

test('it replaces the fleet wholesale on write', () => {
  const store = new StateStore(join(setupDir(), 'state.db'));

  onTestFinished(() => {
    store.stop();
  });

  store.writeFleet([{ name: 'one', cwd: '/x', claudeId: 'c1' }]);
  store.writeFleet([{ name: 'two', cwd: '/y', claudeId: 'c2' }]);

  expect(store.loadFleet()).toStrictEqual([{ name: 'two', cwd: '/y', claudeId: 'c2' }]);
});

test('it seeds the fleet from a legacy fleet.json once', () => {
  const dir = setupDir();
  const legacy = join(dir, 'fleet.json');

  writeFileSync(legacy, JSON.stringify([{ name: 'seeded', cwd: '/z', claudeId: 'c9' }]));

  const store = new StateStore(join(dir, 'state.db'), legacy);

  onTestFinished(() => {
    store.stop();
  });

  expect(store.loadFleet()).toStrictEqual([{ name: 'seeded', cwd: '/z', claudeId: 'c9' }]);
});

test('it never overwrites an existing fleet table from the legacy file', () => {
  const dir = setupDir();
  const legacy = join(dir, 'fleet.json');
  const dbPath = join(dir, 'state.db');

  writeFileSync(legacy, JSON.stringify([{ name: 'stale', cwd: '/old', claudeId: 'c0' }]));

  const first = new StateStore(dbPath, legacy);

  first.writeFleet([{ name: 'fresh', cwd: '/new', claudeId: 'c1' }]);
  first.stop();

  const second = new StateStore(dbPath, legacy);

  onTestFinished(() => {
    second.stop();
  });

  expect(second.loadFleet()).toStrictEqual([{ name: 'fresh', cwd: '/new', claudeId: 'c1' }]);
});

test('it records hook events into the trail', () => {
  const dir = setupDir();
  const dbPath = join(dir, 'state.db');

  const store = new StateStore(dbPath);

  onTestFinished(() => {
    store.stop();
  });

  store.recordEvent({
    atcId: 's1',
    event: 'Notification',
    payload: { message: 'needs permission', session_id: 'c1' },
  });

  const db = new Database(dbPath, { readonly: true });

  onTestFinished(() => {
    db.close();
  });

  const rows = db
    .query<{ atc_id: string; event: string; message: string; session_id: string }, []>(
      'SELECT atc_id, event, message, session_id FROM events',
    )
    .all();

  expect(rows).toStrictEqual([
    { atc_id: 's1', event: 'Notification', message: 'needs permission', session_id: 'c1' },
  ]);
});

test('it reports the latest event timestamp per agent session', () => {
  const dir = setupDir();
  const dbPath = join(dir, 'state.db');

  const store = new StateStore(dbPath);

  onTestFinished(() => {
    store.stop();
  });

  const db = new Database(dbPath);

  onTestFinished(() => {
    db.close();
  });

  db.run(
    'INSERT INTO events (ts, atc_id, event, message, session_id) VALUES ' +
      "('2026-08-14T00:00:01.000Z', 's1', 'SessionStart', NULL, 'c1')," +
      "('2026-08-14T00:00:03.000Z', 's1', 'Stop', NULL, 'c1')," +
      "('2026-08-14T00:00:02.000Z', 's2', 'SessionStart', NULL, 'c2')," +
      "('2026-08-14T00:00:04.000Z', 's3', 'SessionStart', NULL, NULL)",
  );

  expect(store.collectFleetRecency()).toStrictEqual(
    new Map([
      ['c1', '2026-08-14T00:00:03.000Z'],
      ['c2', '2026-08-14T00:00:02.000Z'],
    ]),
  );
});

test('it lists spawn directories most recent first without duplicates', async () => {
  const store = new StateStore(join(setupDir(), 'state.db'));

  onTestFinished(() => {
    store.stop();
  });

  store.recordSpawnDir('/a');

  // The recency ordering key has millisecond resolution.
  await Bun.sleep(2);

  store.recordSpawnDir('/b');

  await Bun.sleep(2);

  store.recordSpawnDir('/a');

  expect(store.collectSpawnDirs()).toStrictEqual(['/a', '/b']);
});
