import { Database } from 'bun:sqlite';
import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toAgentSessionID } from '../shared/to-agent-session-id';
import { toMessageID } from '../shared/to-message-id';
import { toSessionID } from '../shared/to-session-id';
import type { FleetEntry } from './fleet-entry';
import type { MessageRecord } from './message-record';
import { StateStore } from './state-store';

const UUID = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/;

function isUUID(value: unknown): boolean {
  return typeof value === 'string' && UUID.test(value);
}

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
    .query<{ name: string; timestamp: string }, []>(
      'SELECT name, timestamp FROM kysely_migration ORDER BY name',
    )
    .all();

  db.close();

  return rows.map((row) => ({ name: row.name, appliedAt: row.timestamp }));
}

function updateMigrationLedger(dbPath: string, stamp: string): void {
  const db = new Database(dbPath);

  db.run('UPDATE kysely_migration SET timestamp = ?1', [stamp]);
  db.close();
}

function readLegacyColumn(dbPath: string, column: string): unknown[] {
  const db = new Database(dbPath, { readonly: true });

  const rows = db.query<Record<string, unknown>, []>(`SELECT ${column} FROM fleet`).all();

  db.close();

  return rows.map((row) => row[column]);
}

test('it round-trips the fleet', async () => {
  const store = await StateStore.open(join(setupDir(), 'state.db'));

  onTestFinished(async () => {
    await store.stop();
  });

  await store.writeFleet([
    {
      sessionID: toSessionID('s-c1'),
      name: 'auth-bug',
      cwd: '/x',
      agentSessionID: toAgentSessionID('c1'),
      agent: 'claude',
    },
    {
      sessionID: toSessionID('s-c2'),
      name: 'refactor',
      cwd: '/y',
      agentSessionID: toAgentSessionID('c2'),
      agent: 'claude',
    },
  ]);

  const fleet = await store.loadFleet();

  expect(fleet).toStrictEqual([
    {
      sessionID: toSessionID('s-c1'),
      name: 'auth-bug',
      cwd: '/x',
      agentSessionID: toAgentSessionID('c1'),
      agent: 'claude',
    },
    {
      sessionID: toSessionID('s-c2'),
      name: 'refactor',
      cwd: '/y',
      agentSessionID: toAgentSessionID('c2'),
      agent: 'claude',
    },
  ]);
});

test('it replaces the fleet wholesale on write', async () => {
  const store = await StateStore.open(join(setupDir(), 'state.db'));

  onTestFinished(async () => {
    await store.stop();
  });

  await store.writeFleet([
    {
      sessionID: toSessionID('s-c1'),
      name: 'one',
      cwd: '/x',
      agentSessionID: toAgentSessionID('c1'),
      agent: 'claude',
    },
  ]);

  await store.writeFleet([
    {
      sessionID: toSessionID('s-c2'),
      name: 'two',
      cwd: '/y',
      agentSessionID: toAgentSessionID('c2'),
      agent: 'claude',
    },
  ]);

  const fleet = await store.loadFleet();

  expect(fleet).toStrictEqual([
    {
      sessionID: toSessionID('s-c2'),
      name: 'two',
      cwd: '/y',
      agentSessionID: toAgentSessionID('c2'),
      agent: 'claude',
    },
  ]);
});

test('it never lets two overlapping writes leave a mixed or half-written fleet', async () => {
  const store = await StateStore.open(join(setupDir(), 'state.db'));

  onTestFinished(async () => {
    await store.stop();
  });

  // A seeded fleet is what makes the between-read meaningful: with rows
  // already stored, an empty result can only mean a read landed between a
  // write's delete and its inserts.
  const seed: FleetEntry[] = [
    {
      sessionID: toSessionID('s-c0'),
      name: 'seed',
      cwd: '/s',
      agentSessionID: toAgentSessionID('c0'),
      agent: 'claude',
    },
  ];

  const first: FleetEntry[] = [
    {
      sessionID: toSessionID('s-c1'),
      name: 'one',
      cwd: '/x',
      agentSessionID: toAgentSessionID('c1'),
      agent: 'claude',
    },
  ];

  const second: FleetEntry[] = [
    {
      sessionID: toSessionID('s-c2'),
      name: 'two',
      cwd: '/y',
      agentSessionID: toAgentSessionID('c2'),
      agent: 'claude',
    },
  ];

  await store.writeFleet(seed);

  const writeFirst = store.writeFleet(first);
  const readBetween = store.loadFleet();
  const writeSecond = store.writeFleet(second);

  await Promise.all([writeFirst, writeSecond]);

  const between = await readBetween;
  const final = await store.loadFleet();

  expect(between).toBeOneOf([seed, first, second]);
  expect(final).toBeOneOf([first, second]);
});

test('it resolves stop only after an unawaited writeFleet lands', async () => {
  const dir = setupDir();
  const dbPath = join(dir, 'state.db');

  const store = await StateStore.open(dbPath);

  const entries: FleetEntry[] = [
    {
      sessionID: toSessionID('s-c1'),
      name: 'one',
      cwd: '/x',
      agentSessionID: toAgentSessionID('c1'),
      agent: 'claude',
    },
  ];

  const write = store.writeFleet(entries);

  await store.stop();

  await write;

  const db = new Database(dbPath, { readonly: true });

  onTestFinished(() => {
    db.close();
  });

  const rows = db.query<{ name: string }, []>('SELECT name FROM fleet').all();

  expect(rows).toStrictEqual([{ name: 'one' }]);
});

test('it seeds the fleet from a legacy fleet.json once', async () => {
  const dir = setupDir();
  const legacy = join(dir, 'fleet.json');

  writeFileSync(legacy, JSON.stringify([{ name: 'seeded', cwd: '/z', claudeId: 'c9' }]));

  const store = await StateStore.open(join(dir, 'state.db'), legacy);

  onTestFinished(async () => {
    await store.stop();
  });

  const fleet = await store.loadFleet();

  expect(fleet).toStrictEqual([
    {
      sessionID: expect.toSatisfy(isUUID),
      name: 'seeded',
      cwd: '/z',
      agentSessionID: toAgentSessionID('c9'),
      agent: 'claude',
    },
  ]);
});

test('it never overwrites an existing fleet table from the legacy file', async () => {
  const dir = setupDir();
  const legacy = join(dir, 'fleet.json');
  const dbPath = join(dir, 'state.db');

  writeFileSync(legacy, JSON.stringify([{ name: 'stale', cwd: '/old', claudeId: 'c0' }]));

  const first = await StateStore.open(dbPath, legacy);

  await first.writeFleet([
    {
      sessionID: toSessionID('s-c1'),
      name: 'fresh',
      cwd: '/new',
      agentSessionID: toAgentSessionID('c1'),
      agent: 'claude',
    },
  ]);

  await first.stop();

  const second = await StateStore.open(dbPath, legacy);

  onTestFinished(async () => {
    await second.stop();
  });

  const fleet = await second.loadFleet();

  expect(fleet).toStrictEqual([
    {
      sessionID: toSessionID('s-c1'),
      name: 'fresh',
      cwd: '/new',
      agentSessionID: toAgentSessionID('c1'),
      agent: 'claude',
    },
  ]);
});

test('it records hook events into the trail', async () => {
  const dir = setupDir();
  const dbPath = join(dir, 'state.db');

  const store = await StateStore.open(dbPath);

  onTestFinished(async () => {
    await store.stop();
  });

  await store.recordEvent({
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

test('it records a Grok session id from the camelCase payload key', async () => {
  const dir = setupDir();
  const dbPath = join(dir, 'state.db');

  const store = await StateStore.open(dbPath);

  onTestFinished(async () => {
    await store.stop();
  });

  await store.recordEvent({
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

test('it reports recency for a Grok session id', async () => {
  const store = await StateStore.open(join(setupDir(), 'state.db'));

  onTestFinished(async () => {
    await store.stop();
  });

  await store.recordEvent({
    atcId: toSessionID('s1'),
    event: 'SessionStart',
    payload: { hookEventName: 'session_start', sessionId: 'g1' },
  });

  const recency = await store.collectFleetRecency();

  expect([...recency.keys()]).toStrictEqual([toAgentSessionID('g1')]);
});

test('it reports the latest event timestamp per agent session', async () => {
  const dir = setupDir();
  const dbPath = join(dir, 'state.db');

  const store = await StateStore.open(dbPath);

  onTestFinished(async () => {
    await store.stop();
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

  const recency = await store.collectFleetRecency();

  expect(recency).toStrictEqual(
    new Map([
      [toAgentSessionID('c1'), '2026-08-14T00:00:03.000Z'],
      [toAgentSessionID('c2'), '2026-08-14T00:00:02.000Z'],
    ]),
  );
});

test('it returns an empty recency map when no event carries a session id', async () => {
  const dir = setupDir();
  const dbPath = join(dir, 'state.db');

  const store = await StateStore.open(dbPath);

  onTestFinished(async () => {
    await store.stop();
  });

  const db = new Database(dbPath);

  onTestFinished(() => {
    db.close();
  });

  db.run(
    'INSERT INTO events (ts, atc_id, event, message, session_id) VALUES ' +
      "('2026-08-14T00:00:01.000Z', 's1', 'SessionStart', NULL, NULL)," +
      "('2026-08-14T00:00:02.000Z', 's2', 'SessionStart', NULL, NULL)",
  );

  const recency = await store.collectFleetRecency();

  expect(recency).toStrictEqual(new Map());
});

test('it lists spawn directories most recent first without duplicates', async () => {
  const store = await StateStore.open(join(setupDir(), 'state.db'));

  onTestFinished(async () => {
    await store.stop();
  });

  await store.recordSpawnDir('/a');

  // The recency ordering key has millisecond resolution.
  await Bun.sleep(2);
  await store.recordSpawnDir('/b');
  await Bun.sleep(2);
  await store.recordSpawnDir('/a');

  const dirs = await store.collectSpawnDirs();

  expect(dirs).toStrictEqual(['/a', '/b']);
});

test('it round-trips a grok fleet row', async () => {
  const store = await StateStore.open(join(setupDir(), 'state.db'));

  onTestFinished(async () => {
    await store.stop();
  });

  await store.writeFleet([
    {
      sessionID: toSessionID('s-g1'),
      name: 'mixed',
      cwd: '/g',
      agentSessionID: toAgentSessionID('g1'),
      agent: 'grok',
    },
  ]);

  const fleet = await store.loadFleet();

  expect(fleet).toStrictEqual([
    {
      sessionID: toSessionID('s-g1'),
      name: 'mixed',
      cwd: '/g',
      agentSessionID: toAgentSessionID('g1'),
      agent: 'grok',
    },
  ]);
});

test('it round-trips an exited fleet row', async () => {
  const store = await StateStore.open(join(setupDir(), 'state.db'));

  onTestFinished(async () => {
    await store.stop();
  });

  await store.writeFleet([
    {
      sessionID: toSessionID('s-c1'),
      name: 'archived',
      cwd: '/x',
      agentSessionID: toAgentSessionID('c1'),
      agent: 'claude',
      exited: true,
    },
    {
      sessionID: toSessionID('s-c2'),
      name: 'live',
      cwd: '/y',
      agentSessionID: toAgentSessionID('c2'),
      agent: 'claude',
    },
  ]);

  const fleet = await store.loadFleet();

  expect(fleet).toStrictEqual([
    {
      sessionID: toSessionID('s-c1'),
      name: 'archived',
      cwd: '/x',
      agentSessionID: toAgentSessionID('c1'),
      agent: 'claude',
      exited: true,
    },
    {
      sessionID: toSessionID('s-c2'),
      name: 'live',
      cwd: '/y',
      agentSessionID: toAgentSessionID('c2'),
      agent: 'claude',
    },
  ]);
});

test('it round-trips a sub-session fleet row', async () => {
  const store = await StateStore.open(join(setupDir(), 'state.db'));

  onTestFinished(async () => {
    await store.stop();
  });

  await store.writeFleet([
    {
      sessionID: toSessionID('s-c1'),
      name: 'wrangler',
      cwd: '/x',
      agentSessionID: toAgentSessionID('c1'),
      agent: 'claude',
    },
    {
      sessionID: toSessionID('s-c2'),
      name: 'worker',
      cwd: '/x',
      agentSessionID: toAgentSessionID('c2'),
      agent: 'claude',
      parent: toSessionID('s-c1'),
    },
  ]);

  const fleet = await store.loadFleet();

  expect(fleet).toStrictEqual([
    {
      sessionID: toSessionID('s-c1'),
      name: 'wrangler',
      cwd: '/x',
      agentSessionID: toAgentSessionID('c1'),
      agent: 'claude',
    },
    {
      sessionID: toSessionID('s-c2'),
      name: 'worker',
      cwd: '/x',
      agentSessionID: toAgentSessionID('c2'),
      agent: 'claude',
      parent: toSessionID('s-c1'),
    },
  ]);
});

test('it round-trips a fleet row with its model and effort', async () => {
  const store = await StateStore.open(join(setupDir(), 'state.db'));

  onTestFinished(async () => {
    await store.stop();
  });

  await store.writeFleet([
    {
      sessionID: toSessionID('s-c1'),
      name: 'tuned',
      cwd: '/x',
      agentSessionID: toAgentSessionID('c1'),
      agent: 'claude',
      model: 'opus[1m]',
      effort: 'xhigh',
    },
  ]);

  const fleet = await store.loadFleet();

  expect(fleet).toStrictEqual([
    {
      sessionID: toSessionID('s-c1'),
      name: 'tuned',
      cwd: '/x',
      agentSessionID: toAgentSessionID('c1'),
      agent: 'claude',
      model: 'opus[1m]',
      effort: 'xhigh',
    },
  ]);
});

test('it adds parent to a fleet row that predates it', async () => {
  const dbPath = join(setupDir(), 'state.db');

  const db = new Database(dbPath);

  db.run(`
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

  db.run(
    "INSERT INTO fleet (agent_session_id, name, cwd, pinned, last_attached, agent, exited) VALUES ('c1', 'old', '/x', 0, 555, 'claude', 1)",
  );

  db.close();

  const store = await StateStore.open(dbPath);

  onTestFinished(async () => {
    await store.stop();
  });

  const fleet = await store.loadFleet();

  expect(fleet).toStrictEqual([
    {
      sessionID: expect.toSatisfy(isUUID),
      name: 'old',
      cwd: '/x',
      agentSessionID: toAgentSessionID('c1'),
      agent: 'claude',
      lastAttachedAt: 555,
      exited: true,
    },
  ]);
});

test('it defaults last-used agent to claude and round-trips a write', async () => {
  const store = await StateStore.open(join(setupDir(), 'state.db'));

  onTestFinished(async () => {
    await store.stop();
  });

  const defaultAgent = await store.loadLastUsedAgent();

  expect(defaultAgent).toBe('claude');

  await store.writeLastUsedAgent('grok');

  const afterGrok = await store.loadLastUsedAgent();

  expect(afterGrok).toBe('grok');

  await store.writeLastUsedAgent('claude');

  const afterClaude = await store.loadLastUsedAgent();

  expect(afterClaude).toBe('claude');
});

test('it loads last-used agent from a reopened store', async () => {
  const dbPath = join(setupDir(), 'state.db');

  const first = await StateStore.open(dbPath);

  await first.writeLastUsedAgent('grok');
  await first.stop();

  const second = await StateStore.open(dbPath);

  onTestFinished(async () => {
    await second.stop();
  });

  const agent = await second.loadLastUsedAgent();

  expect(agent).toBe('grok');
});

test('it renames the id column and defaults agent for a store written before both', async () => {
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

  const store = await StateStore.open(dbPath);

  onTestFinished(async () => {
    await store.stop();
  });

  const fleet = await store.loadFleet();

  expect(fleet).toStrictEqual([
    {
      sessionID: expect.toSatisfy(isUUID),
      name: 'old',
      cwd: '/x',
      agentSessionID: toAgentSessionID('c1'),
      agent: 'claude',
    },
  ]);

  expect(readLegacyColumn(dbPath, 'grp')).toStrictEqual(['squad-a']);
});

test('it adds pinned to a fleet row that predates it', async () => {
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

  const store = await StateStore.open(dbPath);

  onTestFinished(async () => {
    await store.stop();
  });

  const fleet = await store.loadFleet();

  expect(fleet).toStrictEqual([
    {
      sessionID: expect.toSatisfy(isUUID),
      name: 'old',
      cwd: '/x',
      agentSessionID: toAgentSessionID('c1'),
      agent: 'grok',
      lastAttachedAt: 555,
      exited: true,
    },
  ]);
});

test('it adds last_attached to a fleet row that predates it', async () => {
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

  const store = await StateStore.open(dbPath);

  onTestFinished(async () => {
    await store.stop();
  });

  const fleet = await store.loadFleet();

  expect(fleet).toStrictEqual([
    {
      sessionID: expect.toSatisfy(isUUID),
      name: 'old',
      cwd: '/x',
      agentSessionID: toAgentSessionID('c1'),
      agent: 'grok',
      pinned: true,
      exited: true,
    },
  ]);
});

test('it adds agent to a fleet row that predates it', async () => {
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

  const store = await StateStore.open(dbPath);

  onTestFinished(async () => {
    await store.stop();
  });

  const fleet = await store.loadFleet();

  expect(fleet).toStrictEqual([
    {
      sessionID: expect.toSatisfy(isUUID),
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

test('it adds exited to a fleet row that predates it', async () => {
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

  const store = await StateStore.open(dbPath);

  onTestFinished(async () => {
    await store.stop();
  });

  const fleet = await store.loadFleet();

  expect(fleet).toStrictEqual([
    {
      sessionID: expect.toSatisfy(isUUID),
      name: 'old',
      cwd: '/x',
      agentSessionID: toAgentSessionID('c1'),
      agent: 'grok',
      pinned: true,
      lastAttachedAt: 555,
    },
  ]);
});

test('it opens a database twice without re-running migrations or corrupting data', async () => {
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

  const first = await StateStore.open(dbPath);
  const seededFleet = await first.loadFleet();

  await first.writeFleet([
    ...seededFleet,
    {
      sessionID: toSessionID('s-c2'),
      name: 'second',
      cwd: '/y',
      agentSessionID: toAgentSessionID('c2'),
      agent: 'claude',
    },
  ]);

  await first.stop();

  const ledgerAfterFirstOpen = collectMigrationLedger(dbPath);

  expect(ledgerAfterFirstOpen.map((row) => row.name)).toStrictEqual([
    '001_create_initial_schema',
    '002_rename_fleet_claude_id_to_agent_session_id',
    '003_add_fleet_pinned',
    '004_add_fleet_last_attached',
    '005_add_fleet_agent',
    '006_add_fleet_exited',
    '007_add_fleet_parent',
    '008_add_fleet_prompt_result_transcript',
    '009_add_events_kind_detail',
    '010_add_events_trail_indexes',
    '011_create_messages',
    '012_index_messages_by_owner',
    '013_add_messages_turn_id',
    '014_add_fleet_model_effort',
    '015_rebuild_fleet_keyed_by_session_id',
    '016_create_session_owner',
  ]);

  updateMigrationLedger(dbPath, 'sentinel');

  const second = await StateStore.open(dbPath);
  const fleet = await second.loadFleet();

  expect(fleet).toStrictEqual([
    {
      sessionID: expect.toSatisfy(isUUID),
      name: 'first',
      cwd: '/x',
      agentSessionID: toAgentSessionID('c1'),
      agent: 'claude',
    },
    {
      sessionID: toSessionID('s-c2'),
      name: 'second',
      cwd: '/y',
      agentSessionID: toAgentSessionID('c2'),
      agent: 'claude',
    },
  ]);

  await second.stop();

  expect(collectMigrationLedger(dbPath).map((row) => row.appliedAt)).toStrictEqual(
    Array.from({ length: ledgerAfterFirstOpen.length }, () => 'sentinel'),
  );
});

test('it ends a fresh database at the same fleet schema as a fully migrated old one', async () => {
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
      exited INTEGER NOT NULL DEFAULT 0,
      parent TEXT
    );
  `);

  old.close();

  const freshStore = await StateStore.open(freshPath);
  const oldStore = await StateStore.open(oldPath);

  await freshStore.stop();
  await oldStore.stop();

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

test('it creates prefs for a database that predates the table', async () => {
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

  const store = await StateStore.open(dbPath);

  onTestFinished(async () => {
    await store.stop();
  });

  const defaultAgent = await store.loadLastUsedAgent();

  expect(defaultAgent).toBe('claude');

  await store.writeLastUsedAgent('grok');

  const afterGrok = await store.loadLastUsedAgent();

  expect(afterGrok).toBe('grok');
});

test("it round-trips a fleet row's prompt, result, and transcript path", async () => {
  const dir = setupDir();

  const store = await StateStore.open(join(dir, 'state.db'));

  onTestFinished(async () => {
    await store.stop();
  });

  const entry: FleetEntry = {
    sessionID: toSessionID('s-c1'),
    name: 'a',
    cwd: '/x',
    agentSessionID: toAgentSessionID('c1'),
    agent: 'claude',
    prompt: 'fix the auth bug',
    result: 'All green.',
    transcriptPath: '/t/c1.jsonl',
  };

  await store.writeFleet([entry]);

  const stored = await store.loadFleet();

  expect(stored).toStrictEqual([entry]);
});

test('it records a hook event with its normalized kind and detail', async () => {
  const dir = setupDir();

  const store = await StateStore.open(join(dir, 'state.db'));

  onTestFinished(async () => {
    await store.stop();
  });

  await store.recordEvent(
    { atcId: toSessionID('s1'), event: 'Stop', payload: { session_id: 'c1' } },
    { kind: 'turn-done', detail: 'all green' },
  );

  const events = await store.collectLatestEvents(10);

  expect(events).toStrictEqual([
    {
      id: expect.toBeNumber(),
      at: expect.toBeNumber(),
      atcID: toSessionID('s1'),
      agentSessionID: toAgentSessionID('c1'),
      kind: 'turn-done',
      detail: 'all green',
    },
  ]);
});

test('it falls back to the hook message for an event recorded without a detail', async () => {
  const dir = setupDir();

  const store = await StateStore.open(join(dir, 'state.db'));

  onTestFinished(async () => {
    await store.stop();
  });

  await store.recordEvent(
    { atcId: toSessionID('s1'), event: 'Notification', payload: { message: 'needs permission' } },
    { kind: 'needs-input' },
  );

  const events = await store.collectLatestEvents(10);

  expect(events).toStrictEqual([
    {
      id: expect.toBeNumber(),
      at: expect.toBeNumber(),
      atcID: toSessionID('s1'),
      agentSessionID: null,
      kind: 'needs-input',
      detail: 'needs permission',
    },
  ]);
});

test('it leaves heartbeats and unclassified events out of the event reads', async () => {
  const dir = setupDir();

  const store = await StateStore.open(join(dir, 'state.db'));

  onTestFinished(async () => {
    await store.stop();
  });

  await store.recordEvent({ atcId: toSessionID('s1'), event: 'Statusline', payload: {} });

  await store.recordEvent(
    { atcId: toSessionID('s1'), event: 'Other', payload: {} },
    { kind: 'heartbeat' },
  );

  await store.recordEvent(
    { atcId: toSessionID('s1'), event: 'SessionStart', payload: {} },
    { kind: 'started' },
  );

  const events = await store.collectLatestEvents(10);

  expect(events.map((event) => event.kind)).toStrictEqual(['started']);
});

test('it collects events after an id oldest first, up to the limit', async () => {
  const dir = setupDir();

  const store = await StateStore.open(join(dir, 'state.db'));

  onTestFinished(async () => {
    await store.stop();
  });

  await store.recordEvent(
    { atcId: toSessionID('s1'), event: 'SessionStart', payload: {} },
    { kind: 'started', detail: 'one' },
  );

  await store.recordEvent(
    { atcId: toSessionID('s1'), event: 'Stop', payload: {} },
    { kind: 'turn-done', detail: 'two' },
  );

  await store.recordEvent(
    { atcId: toSessionID('s1'), event: 'SessionEnd', payload: {} },
    { kind: 'ended', detail: 'three' },
  );

  const [first] = await store.collectLatestEvents(10);

  if (first === undefined) {
    throw new Error('expected events');
  }

  const after = await store.collectEventsAfter(first.id, 1);

  expect(after.map((event) => event.detail)).toStrictEqual(['two']);
});

test('it collects the latest events oldest first', async () => {
  const dir = setupDir();

  const store = await StateStore.open(join(dir, 'state.db'));

  onTestFinished(async () => {
    await store.stop();
  });

  await store.recordEvent(
    { atcId: toSessionID('s1'), event: 'SessionStart', payload: {} },
    { kind: 'started', detail: 'one' },
  );

  await store.recordEvent(
    { atcId: toSessionID('s1'), event: 'Stop', payload: {} },
    { kind: 'turn-done', detail: 'two' },
  );

  await store.recordEvent(
    { atcId: toSessionID('s1'), event: 'SessionEnd', payload: {} },
    { kind: 'ended', detail: 'three' },
  );

  const latest = await store.collectLatestEvents(2);

  expect(latest.map((event) => event.detail)).toStrictEqual(['two', 'three']);
});

test("it loads a session's last activity time by its agent session id", async () => {
  const dir = setupDir();

  const store = await StateStore.open(join(dir, 'state.db'));

  onTestFinished(async () => {
    await store.stop();
  });

  const before = Date.now();

  await store.recordEvent(
    { atcId: toSessionID('s-old'), event: 'Stop', payload: { session_id: 'c1' } },
    { kind: 'turn-done' },
  );

  const at = await store.loadLastActivityAt(toSessionID('s-new'), toAgentSessionID('c1'));

  expect(at).toBeWithin(before, Date.now() + 1);
});

test('it loads no last activity time for a session that never reported', async () => {
  const dir = setupDir();

  const store = await StateStore.open(join(dir, 'state.db'));

  onTestFinished(async () => {
    await store.stop();
  });

  const at = await store.loadLastActivityAt(toSessionID('s1'), undefined);

  expect(at).toBeNull();
});

test('it updates one fleet row without touching its siblings', async () => {
  const store = await StateStore.open(join(setupDir(), 'state.db'));

  onTestFinished(async () => {
    await store.stop();
  });

  await store.writeFleet([
    {
      sessionID: toSessionID('s-a1'),
      name: 'a',
      cwd: '/a',
      agentSessionID: toAgentSessionID('a1'),
      agent: 'claude',
    },
    {
      sessionID: toSessionID('s-b1'),
      name: 'b',
      cwd: '/b',
      agentSessionID: toAgentSessionID('b1'),
      agent: 'claude',
    },
  ]);

  await store.updateFleetEntry(toSessionID('s-a1'), {
    result: 'done',
    transcriptPath: '/a.jsonl',
  });

  const fleet = await store.loadFleet();

  expect(fleet).toIncludeSameMembers([
    {
      sessionID: toSessionID('s-a1'),
      name: 'a',
      cwd: '/a',
      agentSessionID: toAgentSessionID('a1'),
      agent: 'claude',
      result: 'done',
      transcriptPath: '/a.jsonl',
    },
    {
      sessionID: toSessionID('s-b1'),
      name: 'b',
      cwd: '/b',
      agentSessionID: toAgentSessionID('b1'),
      agent: 'claude',
    },
  ]);
});

test('it ignores an update for a session with no fleet row', async () => {
  const store = await StateStore.open(join(setupDir(), 'state.db'));

  onTestFinished(async () => {
    await store.stop();
  });

  await store.updateFleetEntry(toSessionID('ghost'), { result: 'done' });

  const fleet = await store.loadFleet();

  expect(fleet).toStrictEqual([]);
});

test('it serves the event-trail lookups from indexes', async () => {
  const dbPath = join(setupDir(), 'state.db');

  const store = await StateStore.open(dbPath);

  onTestFinished(async () => {
    await store.stop();
  });

  const sqlite = new Database(dbPath, { readonly: true });

  onTestFinished(() => {
    sqlite.close();
  });

  const plan = (query: string) =>
    sqlite
      .query<{ detail: string }, []>(`EXPLAIN QUERY PLAN ${query}`)
      .all()
      .map((row) => row.detail)
      .join('\n');

  expect(
    plan(
      "SELECT id FROM events WHERE id > 5 AND kind IS NOT NULL AND kind != 'heartbeat' ORDER BY id LIMIT 5",
    ),
  ).toInclude('USING INDEX events_trail');

  expect(
    plan(
      "SELECT id FROM events WHERE kind IS NOT NULL AND kind != 'heartbeat' ORDER BY id DESC LIMIT 5",
    ),
  ).toInclude('USING INDEX events_trail');

  const activityPlan = plan("SELECT MAX(ts) FROM events WHERE atc_id = 'a' OR session_id = 'b'");

  expect(activityPlan).toInclude('USING INDEX events_atc_id_ts');
  expect(activityPlan).toInclude('USING INDEX events_session_id_ts');
});

test('it lists an accepted message as pending for the session it was sent to', async () => {
  const store = await StateStore.open(join(setupDir(), 'state.db'));

  onTestFinished(async () => {
    await store.stop();
  });

  const record: MessageRecord = {
    id: toMessageID('m-1'),
    atcID: toSessionID('s1'),
    from: 'alice',
    text: 'hello m-1',
    status: 'accepted',
    sentAt: 1000,
  };

  await store.writeMessage(record);

  const pending = await store.collectPendingMessages({ atcID: toSessionID('s1') });

  expect(pending).toStrictEqual([record]);
});

test('it lists pending messages in the order they were sent', async () => {
  const store = await StateStore.open(join(setupDir(), 'state.db'));

  onTestFinished(async () => {
    await store.stop();
  });

  const first: MessageRecord = {
    id: toMessageID('m-z'),
    atcID: toSessionID('s1'),
    from: 'alice',
    text: 'hello m-z',
    status: 'accepted',
    sentAt: 1000,
  };

  const second: MessageRecord = {
    id: toMessageID('m-a'),
    atcID: toSessionID('s1'),
    from: 'alice',
    text: 'hello m-a',
    status: 'accepted',
    sentAt: 1000,
  };

  const third: MessageRecord = {
    id: toMessageID('m-m'),
    atcID: toSessionID('s1'),
    from: 'alice',
    text: 'hello m-m',
    status: 'accepted',
    sentAt: 1001,
  };

  await store.writeMessage(first);
  await store.writeMessage(second);
  await store.writeMessage(third);

  const pending = await store.collectPendingMessages({ atcID: toSessionID('s1') });

  expect(pending).toStrictEqual([first, second, third]);
});

test('it finds pending messages by agent session id under a new atc id', async () => {
  const store = await StateStore.open(join(setupDir(), 'state.db'));

  onTestFinished(async () => {
    await store.stop();
  });

  const record: MessageRecord = {
    id: toMessageID('m-1'),
    atcID: toSessionID('s1'),
    from: 'alice',
    text: 'hello m-1',
    status: 'accepted',
    sentAt: 1000,
    agentSessionID: toAgentSessionID('a1'),
  };

  await store.writeMessage(record);

  const pending = await store.collectPendingMessages({
    atcID: toSessionID('s2'),
    agentSessionID: toAgentSessionID('a1'),
  });

  expect(pending).toStrictEqual([record]);
});

test('it moves an accepted message to delivered once', async () => {
  const store = await StateStore.open(join(setupDir(), 'state.db'));

  onTestFinished(async () => {
    await store.stop();
  });

  const record: MessageRecord = {
    id: toMessageID('m-1'),
    atcID: toSessionID('s1'),
    from: 'alice',
    text: 'hello m-1',
    status: 'accepted',
    sentAt: 1000,
  };

  const owner = { atcID: toSessionID('s1') };

  await store.writeMessage(record);

  const first = await store.updateMessageDelivered(record.id, owner, 2000);
  const second = await store.updateMessageDelivered(record.id, owner, 3000);

  expect(first).toStrictEqual({ ...record, status: 'delivered', deliveredAt: 2000 });
  expect(second).toBeNull();

  const pending = await store.collectPendingMessages(owner);

  expect(pending).toStrictEqual([]);
});

test('it moves a delivered message to answered with the final text', async () => {
  const store = await StateStore.open(join(setupDir(), 'state.db'));

  onTestFinished(async () => {
    await store.stop();
  });

  const record: MessageRecord = {
    id: toMessageID('m-1'),
    atcID: toSessionID('s1'),
    from: 'alice',
    text: 'hello m-1',
    status: 'accepted',
    sentAt: 1000,
  };

  const owner = { atcID: toSessionID('s1') };

  await store.writeMessage(record);
  await store.updateMessageDelivered(record.id, owner, 2000);

  const answered = await store.updateMessagesAnswered([record.id], owner, 'done', 3000);

  expect(answered).toStrictEqual([
    {
      ...record,
      status: 'answered',
      deliveredAt: 2000,
      answeredAt: 3000,
      answer: 'done',
    },
  ]);
});

test('it answers an accepted message that was never acked', async () => {
  const store = await StateStore.open(join(setupDir(), 'state.db'));

  onTestFinished(async () => {
    await store.stop();
  });

  const record: MessageRecord = {
    id: toMessageID('m-1'),
    atcID: toSessionID('s1'),
    from: 'alice',
    text: 'hello m-1',
    status: 'accepted',
    sentAt: 1000,
  };

  const owner = { atcID: toSessionID('s1') };

  await store.writeMessage(record);

  const answered = await store.updateMessagesAnswered([record.id], owner, 'done', 3000);

  expect(answered).toStrictEqual([
    {
      ...record,
      status: 'answered',
      answeredAt: 3000,
      answer: 'done',
    },
  ]);
});

test('it refuses to deliver a message owned by another session', async () => {
  const store = await StateStore.open(join(setupDir(), 'state.db'));

  onTestFinished(async () => {
    await store.stop();
  });

  const record: MessageRecord = {
    id: toMessageID('m-1'),
    atcID: toSessionID('s1'),
    from: 'alice',
    text: 'hello m-1',
    status: 'accepted',
    sentAt: 1000,
  };

  await store.writeMessage(record);

  const updated = await store.updateMessageDelivered(record.id, { atcID: toSessionID('s2') }, 2000);

  expect(updated).toBeNull();
});

test('it refuses to answer a message owned by another session', async () => {
  const store = await StateStore.open(join(setupDir(), 'state.db'));

  onTestFinished(async () => {
    await store.stop();
  });

  const record: MessageRecord = {
    id: toMessageID('m-1'),
    atcID: toSessionID('s1'),
    from: 'alice',
    text: 'hello m-1',
    status: 'accepted',
    sentAt: 1000,
  };

  await store.writeMessage(record);

  const updated = await store.updateMessagesAnswered(
    [record.id],
    { atcID: toSessionID('s2') },
    'done',
    2000,
  );

  expect(updated).toStrictEqual([]);
});

test('it gives messages sent before SessionStart their agent session id', async () => {
  const store = await StateStore.open(join(setupDir(), 'state.db'));

  onTestFinished(async () => {
    await store.stop();
  });

  const record: MessageRecord = {
    id: toMessageID('m-1'),
    atcID: toSessionID('s1'),
    from: 'alice',
    text: 'hello m-1',
    status: 'accepted',
    sentAt: 1000,
  };

  await store.writeMessage(record);
  await store.updateMessageOwner(toSessionID('s1'), undefined, toAgentSessionID('a1'));

  const found = await store.findMessage(record.id, {
    atcID: toSessionID('s2'),
    agentSessionID: toAgentSessionID('a1'),
  });

  expect(found).toStrictEqual({ ...record, agentSessionID: toAgentSessionID('a1') });
});

test('it moves messages to a changed agent session id', async () => {
  const store = await StateStore.open(join(setupDir(), 'state.db'));

  onTestFinished(async () => {
    await store.stop();
  });

  const record: MessageRecord = {
    id: toMessageID('m-1'),
    atcID: toSessionID('s1'),
    from: 'alice',
    text: 'hello m-1',
    status: 'accepted',
    sentAt: 1000,
    agentSessionID: toAgentSessionID('a1'),
  };

  await store.writeMessage(record);
  await store.updateMessageOwner(toSessionID('s2'), toAgentSessionID('a1'), toAgentSessionID('a2'));

  const found = await store.findMessage(record.id, {
    atcID: toSessionID('s3'),
    agentSessionID: toAgentSessionID('a2'),
  });

  expect(found).toStrictEqual({ ...record, agentSessionID: toAgentSessionID('a2') });
});

test('it keeps messages across a store reopen', async () => {
  const dbPath = join(setupDir(), 'state.db');

  const record: MessageRecord = {
    id: toMessageID('m-1'),
    atcID: toSessionID('s1'),
    from: 'alice',
    text: 'hello m-1',
    status: 'accepted',
    sentAt: 1000,
  };

  const first = await StateStore.open(dbPath);

  await first.writeMessage(record);
  await first.stop();

  const second = await StateStore.open(dbPath);

  onTestFinished(async () => {
    await second.stop();
  });

  const pending = await second.collectPendingMessages({ atcID: toSessionID('s1') });

  expect(pending).toStrictEqual([record]);
});

test('it finds a message for its own session', async () => {
  const store = await StateStore.open(join(setupDir(), 'state.db'));

  onTestFinished(async () => {
    await store.stop();
  });

  const record: MessageRecord = {
    id: toMessageID('m-1'),
    atcID: toSessionID('s1'),
    from: 'alice',
    text: 'hello m-1',
    status: 'accepted',
    sentAt: 1000,
  };

  await store.writeMessage(record);

  const own = await store.findMessage(record.id, { atcID: toSessionID('s1') });

  expect(own).toStrictEqual(record);
});

test('it finds no message for another session', async () => {
  const store = await StateStore.open(join(setupDir(), 'state.db'));

  onTestFinished(async () => {
    await store.stop();
  });

  const record: MessageRecord = {
    id: toMessageID('m-1'),
    atcID: toSessionID('s1'),
    from: 'alice',
    text: 'hello m-1',
    status: 'accepted',
    sentAt: 1000,
  };

  await store.writeMessage(record);

  const other = await store.findMessage(record.id, { atcID: toSessionID('s2') });

  expect(other).toBeNull();
});

test('it answers the owner lookups for pending messages from an index', async () => {
  const dbPath = join(setupDir(), 'state.db');

  const store = await StateStore.open(dbPath);

  await store.stop();

  const db = new Database(dbPath, { readonly: true });

  onTestFinished(() => {
    db.close();
  });

  const byAtcID = db
    .query<{ detail: string }, []>(
      "EXPLAIN QUERY PLAN SELECT * FROM messages WHERE status = 'accepted' AND atc_id = 's1' ORDER BY sent_at",
    )
    .all();

  const byAgentSessionID = db
    .query<{ detail: string }, []>(
      "EXPLAIN QUERY PLAN SELECT * FROM messages WHERE status = 'accepted' AND agent_session_id = 'a1' ORDER BY sent_at",
    )
    .all();

  expect(byAtcID.map((row) => row.detail).join('\n')).toInclude(
    'USING INDEX messages_atc_id_status_sent_at',
  );

  expect(byAgentSessionID.map((row) => row.detail).join('\n')).toInclude(
    'USING INDEX messages_agent_session_id_status_sent_at',
  );
});

test('it finds a message by its id alone and misses an unknown id', async () => {
  const store = await StateStore.open(join(setupDir(), 'state.db'));

  onTestFinished(async () => {
    await store.stop();
  });

  const record: MessageRecord = {
    id: toMessageID('m-1'),
    atcID: toSessionID('s1'),
    from: 'alice',
    text: 'hello m-1',
    status: 'accepted',
    sentAt: 1000,
  };

  await store.writeMessage(record);

  const found = await store.findMessageByID(record.id);
  const missing = await store.findMessageByID(toMessageID('m-2'));

  expect(found).toStrictEqual(record);
  expect(missing).toBeNull();
});

test('it records a message status change into the trail with its message id', async () => {
  const store = await StateStore.open(join(setupDir(), 'state.db'));

  onTestFinished(async () => {
    await store.stop();
  });

  await store.recordTrailEntry({
    at: 1000,
    atcID: toSessionID('s1'),
    agentSessionID: toAgentSessionID('c1'),
    kind: 'message-accepted',
    message: toMessageID('m-1'),
    detail: 'hello',
  });

  const events = await store.collectLatestEvents(10);

  expect(events).toStrictEqual([
    {
      id: expect.toBeNumber(),
      at: 1000,
      atcID: toSessionID('s1'),
      agentSessionID: toAgentSessionID('c1'),
      kind: 'message-accepted',
      detail: 'hello',
      message: toMessageID('m-1'),
    },
  ]);
});

test('it records a report into the trail with its label', async () => {
  const store = await StateStore.open(join(setupDir(), 'state.db'));

  onTestFinished(async () => {
    await store.stop();
  });

  await store.recordTrailEntry({
    at: 1000,
    atcID: toSessionID('s1'),
    agentSessionID: null,
    kind: 'report',
    label: 'blocked',
    detail: 'need review',
  });

  const events = await store.collectLatestEvents(10);

  expect(events).toStrictEqual([
    {
      id: expect.toBeNumber(),
      at: 1000,
      atcID: toSessionID('s1'),
      agentSessionID: null,
      kind: 'report',
      detail: 'need review',
      label: 'blocked',
    },
  ]);
});

test('it reads the trail in order across hook events and message entries', async () => {
  const store = await StateStore.open(join(setupDir(), 'state.db'));

  onTestFinished(async () => {
    await store.stop();
  });

  await store.recordEvent(
    { atcId: toSessionID('s1'), event: 'SessionStart', payload: {} },
    { kind: 'started' },
  );

  await store.recordTrailEntry({
    at: 1000,
    atcID: toSessionID('s1'),
    agentSessionID: null,
    kind: 'message-accepted',
    message: toMessageID('m-1'),
    detail: 'hello',
  });

  await store.recordEvent(
    { atcId: toSessionID('s1'), event: 'Stop', payload: {} },
    { kind: 'turn-done' },
  );

  const events = await store.collectLatestEvents(10);

  expect(events.map((e) => e.kind)).toStrictEqual(['started', 'message-accepted', 'turn-done']);
});

test('it stamps trail entries recorded before the agent session id was known', async () => {
  const store = await StateStore.open(join(setupDir(), 'state.db'));

  onTestFinished(async () => {
    await store.stop();
  });

  await store.recordTrailEntry({
    at: 1000,
    atcID: toSessionID('s1'),
    agentSessionID: null,
    kind: 'message-accepted',
    message: toMessageID('m-1'),
    detail: 'hello',
  });

  await store.recordTrailEntry({
    at: 2000,
    atcID: toSessionID('s2'),
    agentSessionID: null,
    kind: 'report',
    label: 'blocked',
    detail: 'other session',
  });

  await store.updateTrailOwner(toSessionID('s1'), toAgentSessionID('c1'));

  const events = await store.collectLatestEvents(10);

  expect(events).toStrictEqual([
    {
      id: expect.toBeNumber(),
      at: 1000,
      atcID: toSessionID('s1'),
      agentSessionID: toAgentSessionID('c1'),
      kind: 'message-accepted',
      detail: 'hello',
      message: toMessageID('m-1'),
    },
    {
      id: expect.toBeNumber(),
      at: 2000,
      atcID: toSessionID('s2'),
      agentSessionID: null,
      kind: 'report',
      detail: 'other session',
      label: 'blocked',
    },
  ]);
});

test("it counts a trail entry toward its session's last activity time", async () => {
  const store = await StateStore.open(join(setupDir(), 'state.db'));

  onTestFinished(async () => {
    await store.stop();
  });

  await store.recordTrailEntry({
    at: 5000,
    atcID: toSessionID('s-old'),
    agentSessionID: toAgentSessionID('c1'),
    kind: 'report',
    label: 'blocked',
    detail: 'need review',
  });

  const at = await store.loadLastActivityAt(toSessionID('s-new'), toAgentSessionID('c1'));

  expect(at).toBe(5000);
});

test('it answers every message of one turn in one call and returns them oldest first', async () => {
  const store = await StateStore.open(join(setupDir(), 'state.db'));

  onTestFinished(async () => {
    await store.stop();
  });

  const owner = { atcID: toSessionID('s1') };

  const base = {
    atcID: toSessionID('s1'),
    from: 'alice',
    status: 'accepted' as const,
  };

  await store.writeMessage({ ...base, id: toMessageID('m-2'), text: 'two', sentAt: 2000 });
  await store.writeMessage({ ...base, id: toMessageID('m-1'), text: 'one', sentAt: 1000 });

  const answered = await store.updateMessagesAnswered(
    [toMessageID('m-2'), toMessageID('m-1')],
    owner,
    'both',
    3000,
    't-1',
  );

  const [oldest] = answered;

  if (oldest === undefined) {
    throw new Error('nothing answered');
  }

  const siblings = await store.collectTurnSiblings(oldest);

  expect(answered.map((record) => [record.id, record.turn])).toStrictEqual([
    [toMessageID('m-1'), 't-1'],
    [toMessageID('m-2'), 't-1'],
  ]);

  expect(siblings).toStrictEqual([toMessageID('m-2')]);
});

test('it lists the other messages of one turn in send order when they share a send time', async () => {
  const store = await StateStore.open(join(setupDir(), 'state.db'));

  onTestFinished(async () => {
    await store.stop();
  });

  const owner = { atcID: toSessionID('s1') };

  const base = {
    atcID: toSessionID('s1'),
    from: 'alice',
    status: 'accepted' as const,
    sentAt: 1000,
  };

  await store.writeMessage({ ...base, id: toMessageID('m-c'), text: 'first' });
  await store.writeMessage({ ...base, id: toMessageID('m-b'), text: 'second' });
  await store.writeMessage({ ...base, id: toMessageID('m-a'), text: 'third' });

  await store.updateMessagesAnswered(
    [toMessageID('m-c'), toMessageID('m-b'), toMessageID('m-a')],
    owner,
    'all',
    2000,
    't-1',
  );

  const first = await store.findMessage(toMessageID('m-c'), owner);

  if (first === null) {
    throw new Error('first message missing');
  }

  const siblings = await store.collectTurnSiblings(first);

  expect(siblings).toStrictEqual([toMessageID('m-b'), toMessageID('m-a')]);
});

test('it links a legacy fleet.json sub-session to its parent by the minted session id', async () => {
  const dir = setupDir();
  const legacy = join(dir, 'fleet.json');

  writeFileSync(
    legacy,
    JSON.stringify([
      { name: 'wrangler', cwd: '/z', agentSessionID: 'c-parent' },
      { name: 'worker', cwd: '/z', agentSessionID: 'c-child', parent: 'c-parent' },
    ]),
  );

  const store = await StateStore.open(join(dir, 'state.db'), legacy);

  onTestFinished(async () => {
    await store.stop();
  });

  const fleet = await store.loadFleet();

  const parent = fleet.find((entry) => entry.name === 'wrangler');
  const child = fleet.find((entry) => entry.name === 'worker');

  if (parent === undefined || child === undefined) {
    throw new Error('expected both seeded entries');
  }

  expect(child.parent).toBe(parent.sessionID);
});

test('it rebuilds a fleet at the model-and-effort shape keyed by a minted session id', async () => {
  const dbPath = join(setupDir(), 'state.db');

  const db = new Database(dbPath);

  db.run(`
    CREATE TABLE fleet (
      agent_session_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      cwd TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      last_attached INTEGER,
      agent TEXT NOT NULL DEFAULT 'claude',
      exited INTEGER NOT NULL DEFAULT 0,
      parent TEXT,
      prompt TEXT,
      result TEXT,
      transcript_path TEXT,
      model TEXT,
      effort TEXT
    );
  `);

  db.run(`
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      atc_id TEXT NOT NULL,
      event TEXT NOT NULL,
      message TEXT,
      session_id TEXT,
      kind TEXT,
      detail TEXT
    );
  `);

  db.run('CREATE TABLE spawn_history (cwd TEXT PRIMARY KEY, last_spawn INTEGER NOT NULL);');
  db.run('CREATE TABLE prefs (key TEXT PRIMARY KEY, value TEXT NOT NULL);');

  db.run(`
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      atc_id TEXT NOT NULL,
      agent_session_id TEXT,
      sender TEXT NOT NULL,
      text TEXT NOT NULL,
      status TEXT NOT NULL,
      sent_at INTEGER NOT NULL,
      delivered_at INTEGER,
      answered_at INTEGER,
      answer TEXT,
      turn_id TEXT
    );
  `);

  db.run(
    'CREATE TABLE kysely_migration (name VARCHAR(255) PRIMARY KEY NOT NULL, timestamp VARCHAR(255) NOT NULL);',
  );

  db.run(
    'INSERT INTO kysely_migration (name, timestamp) VALUES ' +
      "('001_create_initial_schema', 'then'), " +
      "('002_rename_fleet_claude_id_to_agent_session_id', 'then'), " +
      "('003_add_fleet_pinned', 'then'), " +
      "('004_add_fleet_last_attached', 'then'), " +
      "('005_add_fleet_agent', 'then'), " +
      "('006_add_fleet_exited', 'then'), " +
      "('007_add_fleet_parent', 'then'), " +
      "('008_add_fleet_prompt_result_transcript', 'then'), " +
      "('009_add_events_kind_detail', 'then'), " +
      "('010_add_events_trail_indexes', 'then'), " +
      "('011_create_messages', 'then'), " +
      "('012_index_messages_by_owner', 'then'), " +
      "('013_add_messages_turn_id', 'then'), " +
      "('014_add_fleet_model_effort', 'then')",
  );

  db.run(
    'INSERT INTO fleet (agent_session_id, name, cwd, pinned, last_attached, agent, exited, parent, prompt, result, transcript_path, model, effort) VALUES ' +
      "('c-parent', 'wrangler', '/x', 1, 555, 'claude', 0, NULL, 'go', 'done', '/t.jsonl', 'opus', 'high'), " +
      "('c-child', 'worker', '/x', 0, NULL, 'claude', 1, 'c-parent', NULL, NULL, NULL, NULL, NULL), " +
      "('c-orphan', 'stray', '/x', 0, NULL, 'grok', 0, 'c-gone', NULL, NULL, NULL, NULL, NULL), " +
      "(NULL, 'unreported', '/x', 0, NULL, 'claude', 1, NULL, NULL, NULL, NULL, NULL, NULL)",
  );

  db.close();

  const store = await StateStore.open(dbPath);

  onTestFinished(async () => {
    await store.stop();
  });

  const fleet = await store.loadFleet();

  const parent = fleet.find((entry) => entry.name === 'wrangler');

  if (parent === undefined) {
    throw new Error('expected the parent row');
  }

  expect(fleet).toIncludeSameMembers([
    {
      sessionID: expect.toSatisfy(isUUID),
      name: 'wrangler',
      cwd: '/x',
      agentSessionID: toAgentSessionID('c-parent'),
      agent: 'claude',
      pinned: true,
      lastAttachedAt: 555,
      prompt: 'go',
      result: 'done',
      transcriptPath: '/t.jsonl',
      model: 'opus',
      effort: 'high',
    },
    {
      sessionID: expect.toSatisfy(isUUID),
      name: 'worker',
      cwd: '/x',
      agentSessionID: toAgentSessionID('c-child'),
      agent: 'claude',
      exited: true,
      parent: parent.sessionID,
    },
    {
      sessionID: expect.toSatisfy(isUUID),
      name: 'stray',
      cwd: '/x',
      agentSessionID: toAgentSessionID('c-orphan'),
      agent: 'grok',
    },
    {
      sessionID: expect.toSatisfy(isUUID),
      name: 'unreported',
      cwd: '/x',
      agent: 'claude',
      exited: true,
    },
  ]);

  expect(new Set(fleet.map((entry) => entry.sessionID)).size).toBe(4);

  expect(collectMigrationLedger(dbPath).map((row) => row.name)).toContain(
    '015_rebuild_fleet_keyed_by_session_id',
  );
});

test('it keeps a fleet row that has no agent session id', async () => {
  const store = await StateStore.open(join(setupDir(), 'state.db'));

  onTestFinished(async () => {
    await store.stop();
  });

  await store.writeFleet([
    { sessionID: toSessionID('s-new'), name: 'booting', cwd: '/x', agent: 'claude' },
  ]);

  const fleet = await store.loadFleet();

  expect(fleet).toStrictEqual([
    { sessionID: toSessionID('s-new'), name: 'booting', cwd: '/x', agent: 'claude' },
  ]);
});

test('it keeps the later of two fleet entries that share an agent session id', async () => {
  const store = await StateStore.open(join(setupDir(), 'state.db'));

  onTestFinished(async () => {
    await store.stop();
  });

  await store.writeFleet([
    {
      sessionID: toSessionID('s-first'),
      name: 'first',
      cwd: '/x',
      agentSessionID: toAgentSessionID('c1'),
      agent: 'claude',
    },
    {
      sessionID: toSessionID('s-resumed'),
      name: 'resumed',
      cwd: '/x',
      agentSessionID: toAgentSessionID('c1'),
      agent: 'claude',
    },
  ]);

  const fleet = await store.loadFleet();

  expect(fleet).toStrictEqual([
    {
      sessionID: toSessionID('s-resumed'),
      name: 'resumed',
      cwd: '/x',
      agentSessionID: toAgentSessionID('c1'),
      agent: 'claude',
    },
  ]);
});

test('it keeps the same daemon id across a reopen', async () => {
  const dbPath = join(setupDir(), 'state.db');

  const first = await StateStore.open(dbPath);

  const firstID = first.daemonID;

  await first.stop();

  const second = await StateStore.open(dbPath);

  onTestFinished(async () => {
    await second.stop();
  });

  expect(firstID).toSatisfy(isUUID);
  expect(second.daemonID).toBe(firstID);
});

test('it records this daemon as the owner of every fleet row it migrates', async () => {
  const dbPath = join(setupDir(), 'state.db');

  const db = new Database(dbPath);

  db.run(`
    CREATE TABLE fleet (
      agent_session_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      cwd TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      last_attached INTEGER,
      agent TEXT NOT NULL DEFAULT 'claude',
      exited INTEGER NOT NULL DEFAULT 0,
      parent TEXT
    );
  `);

  db.run(
    "INSERT INTO fleet (agent_session_id, name, cwd) VALUES ('c1', 'one', '/x'), ('c2', 'two', '/y')",
  );

  db.close();

  const store = await StateStore.open(dbPath);

  const daemonID = store.daemonID;

  const fleet = await store.loadFleet();

  await store.stop();

  const reader = new Database(dbPath, { readonly: true });

  onTestFinished(() => {
    reader.close();
  });

  const owners = reader
    .query<{ session_id: string; daemon_id: string; owner_epoch: number }, []>(
      'SELECT session_id, daemon_id, owner_epoch FROM session_owner',
    )
    .all();

  expect(owners).toIncludeSameMembers(
    fleet.map((entry) => ({ session_id: entry.sessionID, daemon_id: daemonID, owner_epoch: 1 })),
  );

  expect(owners).toHaveLength(2);
});

test("it rewrites only this daemon's fleet rows and leaves another daemon's in place", async () => {
  const dbPath = join(setupDir(), 'state.db');

  const store = await StateStore.open(dbPath);

  onTestFinished(async () => {
    await store.stop();
  });

  const other = new Database(dbPath);

  other.run(
    "INSERT INTO fleet (session_id, agent_session_id, name, cwd) VALUES ('s-theirs', 'c-theirs', 'theirs', '/z')",
  );

  other.run(
    "INSERT INTO session_owner (session_id, daemon_id, updated_at) VALUES ('s-theirs', 'd-other', 1)",
  );

  other.close();

  await store.writeFleet([
    { sessionID: toSessionID('s-mine'), name: 'mine', cwd: '/x', agent: 'claude' },
  ]);

  await store.writeFleet([
    { sessionID: toSessionID('s-next'), name: 'next', cwd: '/y', agent: 'claude' },
  ]);

  const reader = new Database(dbPath, { readonly: true });

  onTestFinished(() => {
    reader.close();
  });

  const stored = reader
    .query<{ session_id: string }, []>('SELECT session_id FROM fleet ORDER BY session_id')
    .all()
    .map((row) => row.session_id);

  const fleet = await store.loadFleet();

  expect(stored).toStrictEqual(['s-next', 's-theirs']);

  expect(fleet).toStrictEqual([
    { sessionID: toSessionID('s-next'), name: 'next', cwd: '/y', agent: 'claude' },
  ]);
});

test('it rejects a fleet write for a session whose ownership epoch moved on as stale_epoch', async () => {
  const dbPath = join(setupDir(), 'state.db');

  const store = await StateStore.open(dbPath);

  onTestFinished(async () => {
    await store.stop();
  });

  await store.writeFleet([
    { sessionID: toSessionID('s-1'), name: 'before', cwd: '/x', agent: 'claude' },
  ]);

  const other = new Database(dbPath);

  other.run("UPDATE session_owner SET owner_epoch = 2 WHERE session_id = 's-1'");
  other.close();

  const write = store.writeFleet([
    { sessionID: toSessionID('s-1'), name: 'after', cwd: '/x', agent: 'claude' },
  ]);

  expect(write).rejects.toMatchObject({ code: 'stale_epoch' });

  const fleet = await store.loadFleet();

  expect(fleet).toStrictEqual([
    { sessionID: toSessionID('s-1'), name: 'before', cwd: '/x', agent: 'claude' },
  ]);
});

test('it rejects a fleet write for a session another daemon owns as stale_epoch', async () => {
  const dbPath = join(setupDir(), 'state.db');

  const store = await StateStore.open(dbPath);

  onTestFinished(async () => {
    await store.stop();
  });

  const other = new Database(dbPath);

  other.run(
    "INSERT INTO session_owner (session_id, daemon_id, updated_at) VALUES ('s-theirs', 'd-other', 1)",
  );

  other.close();

  const write = store.writeFleet([
    { sessionID: toSessionID('s-theirs'), name: 'stolen', cwd: '/x', agent: 'claude' },
  ]);

  expect(write).rejects.toMatchObject({ code: 'stale_epoch' });
});

test('it rejects a fleet row update for a session whose ownership epoch moved on as stale_epoch', async () => {
  const dbPath = join(setupDir(), 'state.db');

  const store = await StateStore.open(dbPath);

  onTestFinished(async () => {
    await store.stop();
  });

  await store.writeFleet([
    { sessionID: toSessionID('s-1'), name: 'one', cwd: '/x', agent: 'claude' },
  ]);

  const other = new Database(dbPath);

  other.run("UPDATE session_owner SET owner_epoch = 2 WHERE session_id = 's-1'");
  other.close();

  expect(store.updateFleetEntry(toSessionID('s-1'), { result: 'late' })).rejects.toMatchObject({
    code: 'stale_epoch',
  });
});

test('it writes no row as its own parent when every row in a chain shares one agent session id', async () => {
  const store = await StateStore.open(join(setupDir(), 'state.db'));

  onTestFinished(async () => {
    await store.stop();
  });

  await store.writeFleet([
    {
      sessionID: toSessionID('s-top'),
      name: 'top',
      cwd: '/x',
      agentSessionID: toAgentSessionID('c1'),
      agent: 'claude',
    },
    {
      sessionID: toSessionID('s-sub'),
      name: 'sub',
      cwd: '/x',
      agentSessionID: toAgentSessionID('c1'),
      agent: 'claude',
      parent: toSessionID('s-top'),
    },
    {
      sessionID: toSessionID('s-resumed'),
      name: 'resumed',
      cwd: '/x',
      agentSessionID: toAgentSessionID('c1'),
      agent: 'claude',
      parent: toSessionID('s-sub'),
    },
  ]);

  const fleet = await store.loadFleet();

  expect(fleet).toStrictEqual([
    {
      sessionID: toSessionID('s-resumed'),
      name: 'resumed',
      cwd: '/x',
      agentSessionID: toAgentSessionID('c1'),
      agent: 'claude',
    },
  ]);
});

test('it moves the sub-sessions of a replaced row up to the parent of the sub-session that replaced it', async () => {
  const store = await StateStore.open(join(setupDir(), 'state.db'));

  onTestFinished(async () => {
    await store.stop();
  });

  await store.writeFleet([
    {
      sessionID: toSessionID('s-other'),
      name: 'other',
      cwd: '/x',
      agentSessionID: toAgentSessionID('c-other'),
      agent: 'claude',
    },
    {
      sessionID: toSessionID('s-first'),
      name: 'first',
      cwd: '/x',
      agentSessionID: toAgentSessionID('c1'),
      agent: 'claude',
    },
    {
      sessionID: toSessionID('s-worker'),
      name: 'worker',
      cwd: '/x',
      agentSessionID: toAgentSessionID('c-worker'),
      agent: 'claude',
      parent: toSessionID('s-first'),
    },
    {
      sessionID: toSessionID('s-resumed'),
      name: 'resumed',
      cwd: '/x',
      agentSessionID: toAgentSessionID('c1'),
      agent: 'claude',
      parent: toSessionID('s-other'),
    },
  ]);

  const fleet = await store.loadFleet();

  expect(fleet.map((entry) => [entry.sessionID, entry.parent])).toStrictEqual([
    [toSessionID('s-other'), undefined],
    [toSessionID('s-worker'), toSessionID('s-other')],
    [toSessionID('s-resumed'), toSessionID('s-other')],
  ]);
});

test('it breaks the cycle two crossed resumes make by keeping the earlier row top-level', async () => {
  const store = await StateStore.open(join(setupDir(), 'state.db'));

  onTestFinished(async () => {
    await store.stop();
  });

  // R resumes P's agent session under Q, and S resumes Q's under P: replacing
  // P with R and Q with S links R under S and S under R.
  await store.writeFleet([
    {
      sessionID: toSessionID('s-p'),
      name: 'p',
      cwd: '/x',
      agentSessionID: toAgentSessionID('c-a'),
      agent: 'claude',
    },
    {
      sessionID: toSessionID('s-q'),
      name: 'q',
      cwd: '/x',
      agentSessionID: toAgentSessionID('c-b'),
      agent: 'claude',
    },
    {
      sessionID: toSessionID('s-r'),
      name: 'r',
      cwd: '/x',
      agentSessionID: toAgentSessionID('c-a'),
      agent: 'claude',
      parent: toSessionID('s-q'),
    },
    {
      sessionID: toSessionID('s-s'),
      name: 's',
      cwd: '/x',
      agentSessionID: toAgentSessionID('c-b'),
      agent: 'claude',
      parent: toSessionID('s-p'),
    },
  ]);

  const fleet = await store.loadFleet();

  expect(fleet.map((entry) => [entry.sessionID, entry.parent])).toStrictEqual([
    [toSessionID('s-r'), undefined],
    [toSessionID('s-s'), toSessionID('s-r')],
  ]);
});

test('it writes every relinked fleet as a one-level hierarchy of rows it holds', async () => {
  const fixtures: FleetEntry[][] = [
    // A resume under the session whose agent session it resumes.
    [
      {
        sessionID: toSessionID('p'),
        name: 'p',
        cwd: '/x',
        agentSessionID: toAgentSessionID('a'),
        agent: 'claude',
      },
      {
        sessionID: toSessionID('w'),
        name: 'w',
        cwd: '/x',
        agentSessionID: toAgentSessionID('w'),
        agent: 'claude',
        parent: toSessionID('p'),
      },
      {
        sessionID: toSessionID('r'),
        name: 'r',
        cwd: '/x',
        agentSessionID: toAgentSessionID('a'),
        agent: 'claude',
        parent: toSessionID('p'),
      },
    ],

    // Two crossed resumes.
    [
      {
        sessionID: toSessionID('p'),
        name: 'p',
        cwd: '/x',
        agentSessionID: toAgentSessionID('a'),
        agent: 'claude',
      },
      {
        sessionID: toSessionID('q'),
        name: 'q',
        cwd: '/x',
        agentSessionID: toAgentSessionID('b'),
        agent: 'claude',
      },
      {
        sessionID: toSessionID('r'),
        name: 'r',
        cwd: '/x',
        agentSessionID: toAgentSessionID('a'),
        agent: 'claude',
        parent: toSessionID('q'),
      },
      {
        sessionID: toSessionID('s'),
        name: 's',
        cwd: '/x',
        agentSessionID: toAgentSessionID('b'),
        agent: 'claude',
        parent: toSessionID('p'),
      },
    ],

    // Three resumes crossed in a ring, each with a worker under the row it replaces.
    [
      {
        sessionID: toSessionID('p'),
        name: 'p',
        cwd: '/x',
        agentSessionID: toAgentSessionID('a'),
        agent: 'claude',
      },
      {
        sessionID: toSessionID('q'),
        name: 'q',
        cwd: '/x',
        agentSessionID: toAgentSessionID('b'),
        agent: 'claude',
      },
      {
        sessionID: toSessionID('t'),
        name: 't',
        cwd: '/x',
        agentSessionID: toAgentSessionID('c'),
        agent: 'claude',
      },
      {
        sessionID: toSessionID('wp'),
        name: 'wp',
        cwd: '/x',
        agentSessionID: toAgentSessionID('wp'),
        agent: 'claude',
        parent: toSessionID('p'),
      },
      {
        sessionID: toSessionID('wq'),
        name: 'wq',
        cwd: '/x',
        agentSessionID: toAgentSessionID('wq'),
        agent: 'claude',
        parent: toSessionID('q'),
      },
      {
        sessionID: toSessionID('r'),
        name: 'r',
        cwd: '/x',
        agentSessionID: toAgentSessionID('a'),
        agent: 'claude',
        parent: toSessionID('q'),
      },
      {
        sessionID: toSessionID('s'),
        name: 's',
        cwd: '/x',
        agentSessionID: toAgentSessionID('b'),
        agent: 'claude',
        parent: toSessionID('t'),
      },
      {
        sessionID: toSessionID('u'),
        name: 'u',
        cwd: '/x',
        agentSessionID: toAgentSessionID('c'),
        agent: 'claude',
        parent: toSessionID('p'),
      },
    ],

    // A chain where every row shares one agent session id.
    [
      {
        sessionID: toSessionID('top'),
        name: 'top',
        cwd: '/x',
        agentSessionID: toAgentSessionID('a'),
        agent: 'claude',
      },
      {
        sessionID: toSessionID('sub'),
        name: 'sub',
        cwd: '/x',
        agentSessionID: toAgentSessionID('a'),
        agent: 'claude',
        parent: toSessionID('top'),
      },
      {
        sessionID: toSessionID('res'),
        name: 'res',
        cwd: '/x',
        agentSessionID: toAgentSessionID('a'),
        agent: 'claude',
        parent: toSessionID('sub'),
      },
    ],

    // A worker under a sub-session that took over its parent's place.
    [
      {
        sessionID: toSessionID('o'),
        name: 'o',
        cwd: '/x',
        agentSessionID: toAgentSessionID('o'),
        agent: 'claude',
      },
      {
        sessionID: toSessionID('f'),
        name: 'f',
        cwd: '/x',
        agentSessionID: toAgentSessionID('a'),
        agent: 'claude',
      },
      {
        sessionID: toSessionID('w'),
        name: 'w',
        cwd: '/x',
        agentSessionID: toAgentSessionID('w'),
        agent: 'claude',
        parent: toSessionID('f'),
      },
      {
        sessionID: toSessionID('r'),
        name: 'r',
        cwd: '/x',
        agentSessionID: toAgentSessionID('a'),
        agent: 'claude',
        parent: toSessionID('o'),
      },
    ],

    // A link to a row the write does not hold.
    [
      {
        sessionID: toSessionID('orphan'),
        name: 'orphan',
        cwd: '/x',
        agentSessionID: toAgentSessionID('o'),
        agent: 'claude',
        parent: toSessionID('gone'),
      },
    ],
  ];

  const violations: string[] = [];

  for (const [index, fixture] of fixtures.entries()) {
    const store = await StateStore.open(join(setupDir(), `state-${index}.db`));

    await store.writeFleet(fixture);

    const fleet = await store.loadFleet();

    await store.stop();

    const parents = new Map(fleet.map((entry) => [entry.sessionID, entry.parent]));

    violations.push(
      ...fleet
        .filter((entry) => entry.parent === entry.sessionID)
        .map((entry) => `fixture ${index}: ${entry.sessionID} is its own parent`),
      ...fleet
        .filter((entry) => entry.parent !== undefined && !parents.has(entry.parent))
        .map((entry) => `fixture ${index}: ${entry.sessionID} has a parent the fleet lacks`),
      ...fleet
        .filter((entry) => entry.parent !== undefined && parents.get(entry.parent) !== undefined)
        .map((entry) => `fixture ${index}: ${entry.sessionID} sits two levels deep or in a cycle`),
    );
  }

  expect(violations).toStrictEqual([]);
});

test("it moves a row that replaced its own parent under that parent's parent", async () => {
  const store = await StateStore.open(join(setupDir(), 'state.db'));

  onTestFinished(async () => {
    await store.stop();
  });

  await store.writeFleet([
    {
      sessionID: toSessionID('s-top'),
      name: 'top',
      cwd: '/x',
      agentSessionID: toAgentSessionID('c-top'),
      agent: 'claude',
    },
    {
      sessionID: toSessionID('s-sub'),
      name: 'sub',
      cwd: '/x',
      agentSessionID: toAgentSessionID('c-a'),
      agent: 'claude',
      parent: toSessionID('s-top'),
    },
    {
      sessionID: toSessionID('s-resumed'),
      name: 'resumed',
      cwd: '/x',
      agentSessionID: toAgentSessionID('c-a'),
      agent: 'claude',
      parent: toSessionID('s-sub'),
    },
  ]);

  const fleet = await store.loadFleet();

  expect(fleet.map((entry) => [entry.sessionID, entry.parent])).toStrictEqual([
    [toSessionID('s-top'), undefined],
    [toSessionID('s-resumed'), toSessionID('s-top')],
  ]);
});
