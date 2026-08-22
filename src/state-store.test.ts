import { Database } from 'bun:sqlite';
import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from './state-store';
import { toAgentSessionID } from './to-agent-session-id';
import { toSessionID } from './to-session-id';

function setupDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'atc-store-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  return dir;
}

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
}

interface TableSchema {
  table: string;
  columns: ColumnInfo[];
}

function collectSchema(db: Database): TableSchema[] {
  return db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => row.name)
    .toSorted()
    .map((table) => ({ table, columns: collectTableColumns(db, table) }));
}

function collectTableColumns(db: Database, table: string): ColumnInfo[] {
  return db
    .query<ColumnInfo, []>(`PRAGMA table_info(${table})`)
    .all()
    .map((column) => ({
      name: column.name,
      type: column.type,
      notnull: column.notnull,
      dflt_value: column.dflt_value,
    }))
    .toSorted((a, b) => a.name.localeCompare(b.name));
}

interface MigrationRecord {
  name: string;
  appliedAt: string;
}

function collectMigrationLedger(dbPath: string): MigrationRecord[] {
  const db = new Database(dbPath, { readonly: true });

  const rows = db
    .query<{ name: string; applied_at: string }, []>(
      'SELECT name, applied_at FROM schema_migrations ORDER BY name',
    )
    .all();

  db.close();

  return rows.map((row) => ({ name: row.name, appliedAt: row.applied_at }));
}

function updateMigrationLedger(dbPath: string, stamp: string): void {
  const db = new Database(dbPath);

  db.run('UPDATE schema_migrations SET applied_at = ?1', [stamp]);
  db.close();
}

function readLegacyColumn(dbPath: string, column: string): unknown[] {
  const db = new Database(dbPath, { readonly: true });

  const rows = db.query<Record<string, unknown>, []>(`SELECT ${column} FROM fleet`).all();

  db.close();

  return rows.map((row) => row[column]);
}

test('it round-trips the fleet', () => {
  const store = new StateStore(join(setupDir(), 'state.db'));

  onTestFinished(() => {
    store.stop();
  });

  store.writeFleet([
    { name: 'auth-bug', cwd: '/x', agentSessionID: toAgentSessionID('c1'), agent: 'claude' },
    { name: 'refactor', cwd: '/y', agentSessionID: toAgentSessionID('c2'), agent: 'claude' },
  ]);

  expect(store.loadFleet()).toStrictEqual([
    { name: 'auth-bug', cwd: '/x', agentSessionID: toAgentSessionID('c1'), agent: 'claude' },
    { name: 'refactor', cwd: '/y', agentSessionID: toAgentSessionID('c2'), agent: 'claude' },
  ]);
});

test('it replaces the fleet wholesale on write', () => {
  const store = new StateStore(join(setupDir(), 'state.db'));

  onTestFinished(() => {
    store.stop();
  });

  store.writeFleet([
    { name: 'one', cwd: '/x', agentSessionID: toAgentSessionID('c1'), agent: 'claude' },
  ]);

  store.writeFleet([
    { name: 'two', cwd: '/y', agentSessionID: toAgentSessionID('c2'), agent: 'claude' },
  ]);

  expect(store.loadFleet()).toStrictEqual([
    { name: 'two', cwd: '/y', agentSessionID: toAgentSessionID('c2'), agent: 'claude' },
  ]);
});

test('it seeds the fleet from a legacy fleet.json once', () => {
  const dir = setupDir();
  const legacy = join(dir, 'fleet.json');

  writeFileSync(legacy, JSON.stringify([{ name: 'seeded', cwd: '/z', claudeId: 'c9' }]));

  const store = new StateStore(join(dir, 'state.db'), legacy);

  onTestFinished(() => {
    store.stop();
  });

  expect(store.loadFleet()).toStrictEqual([
    { name: 'seeded', cwd: '/z', agentSessionID: toAgentSessionID('c9'), agent: 'claude' },
  ]);
});

test('it never overwrites an existing fleet table from the legacy file', () => {
  const dir = setupDir();
  const legacy = join(dir, 'fleet.json');
  const dbPath = join(dir, 'state.db');

  writeFileSync(legacy, JSON.stringify([{ name: 'stale', cwd: '/old', claudeId: 'c0' }]));

  const first = new StateStore(dbPath, legacy);

  first.writeFleet([
    { name: 'fresh', cwd: '/new', agentSessionID: toAgentSessionID('c1'), agent: 'claude' },
  ]);

  first.stop();

  const second = new StateStore(dbPath, legacy);

  onTestFinished(() => {
    second.stop();
  });

  expect(second.loadFleet()).toStrictEqual([
    { name: 'fresh', cwd: '/new', agentSessionID: toAgentSessionID('c1'), agent: 'claude' },
  ]);
});

test('it records hook events into the trail', () => {
  const dir = setupDir();
  const dbPath = join(dir, 'state.db');

  const store = new StateStore(dbPath);

  onTestFinished(() => {
    store.stop();
  });

  store.recordEvent({
    atcId: toSessionID('s1'),
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

test('it records a Grok session id from the camelCase payload key', () => {
  const dir = setupDir();
  const dbPath = join(dir, 'state.db');

  const store = new StateStore(dbPath);

  onTestFinished(() => {
    store.stop();
  });

  store.recordEvent({
    atcId: toSessionID('s1'),
    event: 'SessionStart',
    payload: { hookEventName: 'session_start', sessionId: 'g1' },
  });

  const db = new Database(dbPath, { readonly: true });

  onTestFinished(() => {
    db.close();
  });

  const rows = db
    .query<{ atc_id: string; event: string; message: string | null; session_id: string }, []>(
      'SELECT atc_id, event, message, session_id FROM events',
    )
    .all();

  expect(rows).toStrictEqual([
    { atc_id: 's1', event: 'SessionStart', message: null, session_id: 'g1' },
  ]);
});

test('it reports recency for a Grok session id', () => {
  const store = new StateStore(join(setupDir(), 'state.db'));

  onTestFinished(() => {
    store.stop();
  });

  store.recordEvent({
    atcId: toSessionID('s1'),
    event: 'SessionStart',
    payload: { hookEventName: 'session_start', sessionId: 'g1' },
  });

  expect([...store.collectFleetRecency().keys()]).toStrictEqual([toAgentSessionID('g1')]);
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
      [toAgentSessionID('c1'), '2026-08-14T00:00:03.000Z'],
      [toAgentSessionID('c2'), '2026-08-14T00:00:02.000Z'],
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

test('it round-trips a grok fleet row', () => {
  const store = new StateStore(join(setupDir(), 'state.db'));

  onTestFinished(() => {
    store.stop();
  });

  store.writeFleet([
    { name: 'mixed', cwd: '/g', agentSessionID: toAgentSessionID('g1'), agent: 'grok' },
  ]);

  expect(store.loadFleet()).toStrictEqual([
    { name: 'mixed', cwd: '/g', agentSessionID: toAgentSessionID('g1'), agent: 'grok' },
  ]);
});

test('it round-trips an exited fleet row', () => {
  const store = new StateStore(join(setupDir(), 'state.db'));

  onTestFinished(() => {
    store.stop();
  });

  store.writeFleet([
    {
      name: 'archived',
      cwd: '/x',
      agentSessionID: toAgentSessionID('c1'),
      agent: 'claude',
      exited: true,
    },
    { name: 'live', cwd: '/y', agentSessionID: toAgentSessionID('c2'), agent: 'claude' },
  ]);

  expect(store.loadFleet()).toStrictEqual([
    {
      name: 'archived',
      cwd: '/x',
      agentSessionID: toAgentSessionID('c1'),
      agent: 'claude',
      exited: true,
    },
    { name: 'live', cwd: '/y', agentSessionID: toAgentSessionID('c2'), agent: 'claude' },
  ]);
});

test('it defaults last-used agent to claude and round-trips a write', () => {
  const store = new StateStore(join(setupDir(), 'state.db'));

  onTestFinished(() => {
    store.stop();
  });

  expect(store.loadLastUsedAgent()).toBe('claude');

  store.writeLastUsedAgent('grok');

  expect(store.loadLastUsedAgent()).toBe('grok');

  store.writeLastUsedAgent('claude');

  expect(store.loadLastUsedAgent()).toBe('claude');
});

test('it loads last-used agent from a reopened store', () => {
  const dbPath = join(setupDir(), 'state.db');

  const first = new StateStore(dbPath);

  first.writeLastUsedAgent('grok');
  first.stop();

  const second = new StateStore(dbPath);

  onTestFinished(() => {
    second.stop();
  });

  expect(second.loadLastUsedAgent()).toBe('grok');
});

test('it renames the id column and defaults agent for a store written before both', () => {
  const dbPath = join(setupDir(), 'state.db');

  const db = new Database(dbPath);

  db.run(`
    CREATE TABLE fleet (
      claude_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      cwd TEXT NOT NULL,
      grp TEXT
    );
  `);

  db.run("INSERT INTO fleet (claude_id, name, cwd, grp) VALUES ('c1', 'old', '/x', 'squad-a')");
  db.close();

  const store = new StateStore(dbPath);

  onTestFinished(() => {
    store.stop();
  });

  expect(store.loadFleet()).toStrictEqual([
    { name: 'old', cwd: '/x', agentSessionID: toAgentSessionID('c1'), agent: 'claude' },
  ]);

  expect(readLegacyColumn(dbPath, 'grp')).toStrictEqual(['squad-a']);
});

test('it adds pinned to a fleet row that predates it', () => {
  const dbPath = join(setupDir(), 'state.db');

  const db = new Database(dbPath);

  db.run(`
    CREATE TABLE fleet (
      agent_session_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      cwd TEXT NOT NULL,
      last_attached INTEGER,
      agent TEXT NOT NULL DEFAULT 'claude',
      exited INTEGER NOT NULL DEFAULT 0
    );
  `);

  db.run(
    "INSERT INTO fleet (agent_session_id, name, cwd, last_attached, agent, exited) VALUES ('c1', 'old', '/x', 555, 'grok', 1)",
  );

  db.close();

  const store = new StateStore(dbPath);

  onTestFinished(() => {
    store.stop();
  });

  expect(store.loadFleet()).toStrictEqual([
    {
      name: 'old',
      cwd: '/x',
      agentSessionID: toAgentSessionID('c1'),
      agent: 'grok',
      lastAttachedAt: 555,
      exited: true,
    },
  ]);
});

test('it adds last_attached to a fleet row that predates it', () => {
  const dbPath = join(setupDir(), 'state.db');

  const db = new Database(dbPath);

  db.run(`
    CREATE TABLE fleet (
      agent_session_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      cwd TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      agent TEXT NOT NULL DEFAULT 'claude',
      exited INTEGER NOT NULL DEFAULT 0
    );
  `);

  db.run(
    "INSERT INTO fleet (agent_session_id, name, cwd, pinned, agent, exited) VALUES ('c1', 'old', '/x', 1, 'grok', 1)",
  );

  db.close();

  const store = new StateStore(dbPath);

  onTestFinished(() => {
    store.stop();
  });

  expect(store.loadFleet()).toStrictEqual([
    {
      name: 'old',
      cwd: '/x',
      agentSessionID: toAgentSessionID('c1'),
      agent: 'grok',
      pinned: true,
      exited: true,
    },
  ]);
});

test('it adds agent to a fleet row that predates it', () => {
  const dbPath = join(setupDir(), 'state.db');

  const db = new Database(dbPath);

  db.run(`
    CREATE TABLE fleet (
      agent_session_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      cwd TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      last_attached INTEGER,
      exited INTEGER NOT NULL DEFAULT 0
    );
  `);

  db.run(
    "INSERT INTO fleet (agent_session_id, name, cwd, pinned, last_attached, exited) VALUES ('c1', 'old', '/x', 1, 555, 1)",
  );

  db.close();

  const store = new StateStore(dbPath);

  onTestFinished(() => {
    store.stop();
  });

  expect(store.loadFleet()).toStrictEqual([
    {
      name: 'old',
      cwd: '/x',
      agentSessionID: toAgentSessionID('c1'),
      agent: 'claude',
      pinned: true,
      lastAttachedAt: 555,
      exited: true,
    },
  ]);
});

test('it adds exited to a fleet row that predates it', () => {
  const dbPath = join(setupDir(), 'state.db');

  const db = new Database(dbPath);

  db.run(`
    CREATE TABLE fleet (
      agent_session_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      cwd TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      last_attached INTEGER,
      agent TEXT NOT NULL DEFAULT 'claude'
    );
  `);

  db.run(
    "INSERT INTO fleet (agent_session_id, name, cwd, pinned, last_attached, agent) VALUES ('c1', 'old', '/x', 1, 555, 'grok')",
  );

  db.close();

  const store = new StateStore(dbPath);

  onTestFinished(() => {
    store.stop();
  });

  expect(store.loadFleet()).toStrictEqual([
    {
      name: 'old',
      cwd: '/x',
      agentSessionID: toAgentSessionID('c1'),
      agent: 'grok',
      pinned: true,
      lastAttachedAt: 555,
    },
  ]);
});

test('it opens a database twice without re-running migrations or corrupting data', () => {
  const dbPath = join(setupDir(), 'state.db');

  const legacy = new Database(dbPath);

  legacy.run(`
    CREATE TABLE fleet (
      claude_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      cwd TEXT NOT NULL
    );
  `);

  legacy.run("INSERT INTO fleet (claude_id, name, cwd) VALUES ('c1', 'first', '/x')");
  legacy.close();

  const first = new StateStore(dbPath);

  first.writeFleet([
    ...first.loadFleet(),
    { name: 'second', cwd: '/y', agentSessionID: toAgentSessionID('c2'), agent: 'claude' },
  ]);

  first.stop();

  const ledgerAfterFirstOpen = collectMigrationLedger(dbPath);

  expect(ledgerAfterFirstOpen.map((row) => row.name)).toStrictEqual([
    '001_create_initial_schema',
    '002_rename_fleet_claude_id_to_agent_session_id',
    '003_add_fleet_pinned',
    '004_add_fleet_last_attached',
    '005_add_fleet_agent',
    '006_add_fleet_exited',
  ]);

  updateMigrationLedger(dbPath, 'sentinel');

  const second = new StateStore(dbPath);

  expect(second.loadFleet()).toStrictEqual([
    { name: 'first', cwd: '/x', agentSessionID: toAgentSessionID('c1'), agent: 'claude' },
    { name: 'second', cwd: '/y', agentSessionID: toAgentSessionID('c2'), agent: 'claude' },
  ]);

  second.stop();

  expect(collectMigrationLedger(dbPath).map((row) => row.appliedAt)).toStrictEqual(
    Array.from({ length: ledgerAfterFirstOpen.length }, () => 'sentinel'),
  );
});

test('it ends a fresh database at the same fleet schema as a fully migrated old one', () => {
  const freshPath = join(setupDir(), 'fresh.db');
  const oldPath = join(setupDir(), 'old.db');

  const old = new Database(oldPath);

  old.run(`
    CREATE TABLE fleet (
      agent_session_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      cwd TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      last_attached INTEGER,
      agent TEXT NOT NULL DEFAULT 'claude',
      exited INTEGER NOT NULL DEFAULT 0
    );
  `);

  old.close();

  const freshStore = new StateStore(freshPath);
  const oldStore = new StateStore(oldPath);

  freshStore.stop();
  oldStore.stop();

  const freshDB = new Database(freshPath, { readonly: true });
  const oldDB = new Database(oldPath, { readonly: true });

  onTestFinished(() => {
    freshDB.close();
    oldDB.close();
  });

  const freshSchema = collectSchema(freshDB);
  const oldSchema = collectSchema(oldDB);

  expect(freshSchema).toStrictEqual(oldSchema);
});

test('it creates prefs for a database that predates the table', () => {
  const dbPath = join(setupDir(), 'state.db');

  const db = new Database(dbPath);

  db.run(`
    CREATE TABLE fleet (
      claude_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      cwd TEXT NOT NULL
    );
  `);

  db.run(`
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      atc_id TEXT NOT NULL,
      event TEXT NOT NULL,
      message TEXT,
      session_id TEXT
    );
  `);

  db.run(`
    CREATE TABLE spawn_history (
      cwd TEXT PRIMARY KEY,
      last_spawn INTEGER NOT NULL
    );
  `);

  db.close();

  const store = new StateStore(dbPath);

  onTestFinished(() => {
    store.stop();
  });

  expect(store.loadLastUsedAgent()).toBe('claude');

  store.writeLastUsedAgent('grok');

  expect(store.loadLastUsedAgent()).toBe('grok');
});
