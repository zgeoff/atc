import { Database } from 'bun:sqlite';
import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentSessionID } from './agent-session-id';
import type { SessionID } from './session-id';
import { StateStore } from './state-store';

function toSessionID(id: string): SessionID {
  // oxlint-disable-next-line no-unsafe-type-assertion -- test fixture literal stands in for a minted session id
  return id as SessionID;
}

function toAgentSessionID(id: string): AgentSessionID {
  // oxlint-disable-next-line no-unsafe-type-assertion -- test fixture literal stands in for an agent-minted session id
  return id as AgentSessionID;
}

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

  db.run("INSERT INTO fleet (claude_id, name, cwd, grp) VALUES ('c1', 'old', '/x', NULL)");
  db.close();

  const store = new StateStore(dbPath);

  onTestFinished(() => {
    store.stop();
  });

  expect(store.loadFleet()).toStrictEqual([
    { name: 'old', cwd: '/x', agentSessionID: toAgentSessionID('c1'), agent: 'claude' },
  ]);
});
