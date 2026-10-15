import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { toAgentSessionID, toMessageID, toSessionID } from '@atc/core';
import {
  buildMockPublishedRecord,
  readQueryPlan,
  registerTestCleanup,
  setupTempDir,
} from '@atc/test-utils';
import type { CompiledQuery } from 'kysely';
import invariant from 'tiny-invariant';
import { buildTargetIdentity } from './build-target-identity';
import { StateStore } from './state-store';
import { buildMockFleetEntry } from './testing/build-mock-fleet-entry';
import { buildMockMessageRecord } from './testing/build-mock-message-record';
import { createMigratedStateDB } from './testing/create-migrated-state-db';

async function setupTest() {
  const tmp = setupTempDir('atc-store-');
  const dbPath = join(tmp.dir, 'state.db');

  await createMigratedStateDB(dbPath);

  const queries: CompiledQuery[] = [];

  const store = await StateStore.open(dbPath, undefined, (query) => {
    queries.push(query);
  });

  registerTestCleanup(() => store.stop());

  return { dbPath, store, queries };
}

test('it round-trips the fleet', async () => {
  const ctx = await setupTest();

  const first = buildMockFleetEntry();
  const second = buildMockFleetEntry();

  await ctx.store.writeFleet([first, second]);

  const fleet = await ctx.store.loadFleet();

  expect(fleet).toStrictEqual([first, second]);
});

test('it keeps a stored row that a later write does not cover', async () => {
  const ctx = await setupTest();

  const first = buildMockFleetEntry();
  const second = buildMockFleetEntry();

  await ctx.store.writeFleet([first]);
  await ctx.store.writeFleet([second]);

  const fleet = await ctx.store.loadFleet();

  expect(fleet).toStrictEqual([first, second]);
});

test('it drops the row of a session the write removes', async () => {
  const ctx = await setupTest();

  const removed = buildMockFleetEntry();
  const kept = buildMockFleetEntry();

  await ctx.store.writeFleet([removed, kept]);
  await ctx.store.writeFleet([kept], [removed.sessionID]);

  const fleet = await ctx.store.loadFleet();

  expect(fleet).toStrictEqual([kept]);
});

test('it drops a stored row whose agent session id a written entry holds', async () => {
  const ctx = await setupTest();

  const old = buildMockFleetEntry({ agentSessionID: toAgentSessionID('c-old'), exited: true });
  const resumed = buildMockFleetEntry({ agentSessionID: toAgentSessionID('c-old') });

  await ctx.store.writeFleet([old]);
  await ctx.store.writeFleet([resumed]);

  const fleet = await ctx.store.loadFleet();

  expect(fleet).toStrictEqual([resumed]);
});

test('it keeps a stored live row on another target whose agent session id a written entry holds', async () => {
  const ctx = await setupTest();

  const remote = buildMockFleetEntry({
    agentSessionID: toAgentSessionID('c-shared'),
    target: 'box',
    targetIdentity: 'imp:box',
  });

  const local = buildMockFleetEntry({
    agentSessionID: toAgentSessionID('c-shared'),
    target: 'local',
    targetIdentity: 'local-pty:local',
  });

  await ctx.store.writeFleet([remote]);
  await ctx.store.writeFleet([local]);

  const fleet = await ctx.store.loadFleet();

  expect(fleet).toStrictEqual([remote, local]);
});

test('it keeps a live entry on another target beside a later entry that holds its agent session id', async () => {
  const ctx = await setupTest();

  const remote = buildMockFleetEntry({
    agentSessionID: toAgentSessionID('c-shared'),
    target: 'box',
    targetIdentity: 'imp:box',
  });

  const local = buildMockFleetEntry({
    agentSessionID: toAgentSessionID('c-shared'),
    target: 'local',
    targetIdentity: 'local-pty:local',
  });

  await ctx.store.writeFleet([remote, local]);

  const fleet = await ctx.store.loadFleet();

  expect(fleet).toStrictEqual([remote, local]);
});

test('it keeps the later of two live entries on one target when a live entry on another target follows them', async () => {
  const ctx = await setupTest();

  const first = buildMockFleetEntry({
    agentSessionID: toAgentSessionID('c-shared'),
    target: 'local',
    targetIdentity: 'local-pty:local',
  });

  const second = buildMockFleetEntry({
    agentSessionID: toAgentSessionID('c-shared'),
    target: 'local',
    targetIdentity: 'local-pty:local',
  });

  const remote = buildMockFleetEntry({
    agentSessionID: toAgentSessionID('c-shared'),
    target: 'box',
    targetIdentity: 'imp:box',
  });

  await ctx.store.writeFleet([first, second, remote]);

  const fleet = await ctx.store.loadFleet();

  expect(fleet).toStrictEqual([second, remote]);
});

test('it drops a stored live row on the target of a written entry when a live entry on another target follows it', async () => {
  const ctx = await setupTest();

  const first = buildMockFleetEntry({
    agentSessionID: toAgentSessionID('c-shared'),
    target: 'local',
    targetIdentity: 'local-pty:local',
  });

  const second = buildMockFleetEntry({
    agentSessionID: toAgentSessionID('c-shared'),
    target: 'local',
    targetIdentity: 'local-pty:local',
  });

  const remote = buildMockFleetEntry({
    agentSessionID: toAgentSessionID('c-shared'),
    target: 'box',
    targetIdentity: 'imp:box',
  });

  await ctx.store.writeFleet([first]);
  await ctx.store.writeFleet([second, remote]);

  const fleet = await ctx.store.loadFleet();

  expect(fleet).toStrictEqual([second, remote]);
});

test('it drops a stored exited row on another target whose agent session id a written entry holds', async () => {
  const ctx = await setupTest();

  const remote = buildMockFleetEntry({
    agentSessionID: toAgentSessionID('c-shared'),
    target: 'box',
    targetIdentity: 'imp:box',
    exited: true,
  });

  const local = buildMockFleetEntry({
    agentSessionID: toAgentSessionID('c-shared'),
    target: 'local',
    targetIdentity: 'local-pty:local',
  });

  await ctx.store.writeFleet([remote]);
  await ctx.store.writeFleet([local]);

  const fleet = await ctx.store.loadFleet();

  expect(fleet).toStrictEqual([local]);
});

test('it drops a stored live row without a target identity when a later local entry holds its agent session id', async () => {
  const ctx = await setupTest();

  const legacy = buildMockFleetEntry({ agentSessionID: toAgentSessionID('c-shared') });

  const local = buildMockFleetEntry({
    agentSessionID: toAgentSessionID('c-shared'),
    target: 'local',
    targetIdentity: 'local-pty:44136fa355b3678a',
  });

  await ctx.store.writeFleet([legacy]);
  await ctx.store.writeFleet([local]);

  const fleet = await ctx.store.loadFleet();

  expect(fleet).toStrictEqual([local]);
});

test('it keeps the later of a live entry without a target identity and a local entry that holds its agent session id', async () => {
  const ctx = await setupTest();

  const legacy = buildMockFleetEntry({ agentSessionID: toAgentSessionID('c-shared') });

  const local = buildMockFleetEntry({
    agentSessionID: toAgentSessionID('c-shared'),
    target: 'local',
    targetIdentity: 'local-pty:44136fa355b3678a',
  });

  await ctx.store.writeFleet([legacy, local]);

  const fleet = await ctx.store.loadFleet();

  expect(fleet).toStrictEqual([local]);
});

test('it drops every stored live row without a target identity that a later local entry resumes', async () => {
  const ctx = await setupTest();

  const first = buildMockFleetEntry({ agentSessionID: toAgentSessionID('c-first') });
  const second = buildMockFleetEntry({ agentSessionID: toAgentSessionID('c-second') });

  const resumedFirst = buildMockFleetEntry({
    agentSessionID: toAgentSessionID('c-first'),
    target: 'local',
    targetIdentity: 'local-pty:44136fa355b3678a',
  });

  const resumedSecond = buildMockFleetEntry({
    agentSessionID: toAgentSessionID('c-second'),
    target: 'local',
    targetIdentity: 'local-pty:44136fa355b3678a',
  });

  await ctx.store.writeFleet([first, second]);
  await ctx.store.writeFleet([resumedFirst, resumedSecond]);

  const fleet = await ctx.store.loadFleet();

  expect(fleet).toStrictEqual([resumedFirst, resumedSecond]);
});

test('it keeps a stored live row without a target identity when a later entry on another local identity holds its agent session id', async () => {
  const ctx = await setupTest();

  const legacy = buildMockFleetEntry({ agentSessionID: toAgentSessionID('c-shared') });

  const local = buildMockFleetEntry({
    agentSessionID: toAgentSessionID('c-shared'),
    target: 'local',
    targetIdentity: 'local-pty:0000000000000000',
  });

  await ctx.store.writeFleet([legacy]);
  await ctx.store.writeFleet([local]);

  const fleet = await ctx.store.loadFleet();

  expect(fleet).toStrictEqual([legacy, local]);
});

test('it relinks a stored sub-session to the session that replaced its parent', async () => {
  const ctx = await setupTest();

  const old = buildMockFleetEntry({ agentSessionID: toAgentSessionID('c-old'), exited: true });
  const child = buildMockFleetEntry({ exited: true, parent: old.sessionID });
  const resumed = buildMockFleetEntry({ agentSessionID: toAgentSessionID('c-old') });

  await ctx.store.writeFleet([old, child]);
  await ctx.store.writeFleet([resumed]);

  const fleet = await ctx.store.loadFleet();

  expect(fleet).toStrictEqual([{ ...child, parent: resumed.sessionID }, resumed]);
});

test('it answers a read issued between two unawaited writes, and one after them, with whole fleets', async () => {
  const ctx = await setupTest();

  // With rows already stored, an empty or mixed result would mean a read saw
  // a write half done. The calls only overlap in when they are issued: the
  // test does not hold a write open while the read runs.
  const seed = buildMockFleetEntry();
  const first = buildMockFleetEntry({ sessionID: seed.sessionID });
  const second = buildMockFleetEntry({ sessionID: seed.sessionID });

  await ctx.store.writeFleet([seed]);

  const writeFirst = ctx.store.writeFleet([first]);
  const readBetween = ctx.store.loadFleet();
  const writeSecond = ctx.store.writeFleet([second]);

  await Promise.all([writeFirst, writeSecond]);

  const between = await readBetween;
  const final = await ctx.store.loadFleet();

  expect(between).toBeOneOf([[seed], [first], [second]]);
  expect(final).toBeOneOf([[first], [second]]);
});

test('it resolves stop only after an unawaited fleet write lands', async () => {
  const ctx = await setupTest();

  const entry = buildMockFleetEntry();
  const write = ctx.store.writeFleet([entry]);

  await ctx.store.stop();

  await write;

  const db = new Database(ctx.dbPath, { readonly: true });

  registerTestCleanup(() => {
    db.close();
  });

  const rows = db.query<{ name: string }, []>('SELECT name FROM fleet').all();

  expect(rows).toStrictEqual([{ name: entry.name }]);
});

test('it seeds an empty fleet from a legacy fleet.json', async () => {
  const tmp = setupTempDir('atc-store-');
  const legacy = join(tmp.dir, 'fleet.json');

  writeFileSync(legacy, JSON.stringify([{ name: 'seeded', cwd: '/z', claudeId: 'c9' }]));

  const store = await StateStore.open(join(tmp.dir, 'state.db'), legacy);

  registerTestCleanup(() => store.stop());

  const fleet = await store.loadFleet();

  expect(fleet).toStrictEqual([
    {
      sessionID: expect.toSatisfy((id: string) =>
        /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/.test(id),
      ),
      name: 'seeded',
      cwd: '/z',
      agentSessionID: toAgentSessionID('c9'),
      agent: 'claude',
    },
  ]);
});

test('it never overwrites an existing fleet table from the legacy file', async () => {
  const tmp = setupTempDir('atc-store-');
  const legacy = join(tmp.dir, 'fleet.json');
  const dbPath = join(tmp.dir, 'state.db');

  writeFileSync(legacy, JSON.stringify([{ name: 'stale', cwd: '/old', claudeId: 'c0' }]));

  const first = await StateStore.open(dbPath, legacy);

  registerTestCleanup(() => first.stop());

  const fresh = buildMockFleetEntry();

  await first.writeFleet([fresh]);
  await first.stop();

  const second = await StateStore.open(dbPath, legacy);

  registerTestCleanup(() => second.stop());

  const fleet = await second.loadFleet();

  expect(fleet).toStrictEqual([
    {
      sessionID: expect.toSatisfy((id: string) =>
        /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/.test(id),
      ),
      name: 'stale',
      cwd: '/old',
      agentSessionID: toAgentSessionID('c0'),
      agent: 'claude',
    },
    fresh,
  ]);
});

test('it records hook events into the trail', async () => {
  const ctx = await setupTest();

  await ctx.store.recordEvent({
    atcId: toSessionID('s1'),
    event: 'Notification',
    payload: { message: 'needs permission', session_id: 'c1' },
  });

  const db = new Database(ctx.dbPath, { readonly: true });

  registerTestCleanup(() => {
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
  const ctx = await setupTest();

  await ctx.store.recordEvent({
    atcId: toSessionID('s1'),
    event: 'SessionStart',
    payload: { hookEventName: 'session_start', sessionId: 'g1' },
  });

  const db = new Database(ctx.dbPath, { readonly: true });

  registerTestCleanup(() => {
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

test('it notes recency for a Grok session id', async () => {
  const ctx = await setupTest();

  await ctx.store.recordEvent({
    atcId: toSessionID('s1'),
    event: 'SessionStart',
    payload: { hookEventName: 'session_start', sessionId: 'g1' },
  });

  const recency = await ctx.store.collectFleetRecency();

  expect(recency).toStrictEqual(new Map([[toAgentSessionID('g1'), expect.toBeDateString()]]));
});

test('it notes the latest event timestamp per agent session', async () => {
  const ctx = await setupTest();

  const db = new Database(ctx.dbPath);

  registerTestCleanup(() => {
    db.close();
  });

  db.run(
    'INSERT INTO events (ts, atc_id, event, message, session_id) VALUES ' +
      "('2026-08-14T00:00:01.000Z', 's1', 'SessionStart', NULL, 'c1')," +
      "('2026-08-14T00:00:03.000Z', 's1', 'Stop', NULL, 'c1')," +
      "('2026-08-14T00:00:02.000Z', 's2', 'SessionStart', NULL, 'c2')," +
      "('2026-08-14T00:00:04.000Z', 's3', 'SessionStart', NULL, NULL)",
  );

  const recency = await ctx.store.collectFleetRecency();

  expect(recency).toStrictEqual(
    new Map([
      [toAgentSessionID('c1'), '2026-08-14T00:00:03.000Z'],
      [toAgentSessionID('c2'), '2026-08-14T00:00:02.000Z'],
    ]),
  );
});

test('it returns an empty recency map when no event carries a session id', async () => {
  const ctx = await setupTest();

  const db = new Database(ctx.dbPath);

  registerTestCleanup(() => {
    db.close();
  });

  db.run(
    'INSERT INTO events (ts, atc_id, event, message, session_id) VALUES ' +
      "('2026-08-14T00:00:01.000Z', 's1', 'SessionStart', NULL, NULL)," +
      "('2026-08-14T00:00:02.000Z', 's2', 'SessionStart', NULL, NULL)",
  );

  const recency = await ctx.store.collectFleetRecency();

  expect(recency).toStrictEqual(new Map());
});

test('it lists spawn directories most recent first without duplicates', async () => {
  const ctx = await setupTest();

  await ctx.store.recordSpawnDir('/a', { target: 'local', targetIdentity: 'local-pty:x' }, 1000);
  await ctx.store.recordSpawnDir('/b', { target: 'local', targetIdentity: 'local-pty:x' }, 2000);
  await ctx.store.recordSpawnDir('/a', { target: 'local', targetIdentity: 'local-pty:x' }, 3000);

  const dirs = await ctx.store.collectSpawnDirs();

  expect(dirs).toStrictEqual([
    { cwd: '/a', grant: { target: 'local', targetIdentity: 'local-pty:x' } },
    { cwd: '/b', grant: { target: 'local', targetIdentity: 'local-pty:x' } },
  ]);
});

test('it lists a spawn directory once for each target it was spawned on', async () => {
  const ctx = await setupTest();

  await ctx.store.recordSpawnDir('/a', { target: 'local', targetIdentity: 'local-pty:x' }, 1000);
  await ctx.store.recordSpawnDir('/a', { target: 'box', targetIdentity: 'imp:y' }, 2000);
  await ctx.store.recordSpawnDir('/a', { target: 'box', targetIdentity: 'imp:z' }, 3000);

  const dirs = await ctx.store.collectSpawnDirs();

  expect(dirs).toStrictEqual([
    { cwd: '/a', grant: { target: 'box', targetIdentity: 'imp:z' } },
    { cwd: '/a', grant: { target: 'box', targetIdentity: 'imp:y' } },
    { cwd: '/a', grant: { target: 'local', targetIdentity: 'local-pty:x' } },
  ]);
});

test('it carries spawn directories from before their target was recorded over as spawns on the default local target', async () => {
  const tmp = setupTempDir('atc-store-');
  const dbPath = join(tmp.dir, 'state.db');

  const db = new Database(dbPath);

  registerTestCleanup(() => {
    db.close();
  });

  db.run('CREATE TABLE spawn_history (cwd TEXT PRIMARY KEY, last_spawn INTEGER NOT NULL);');
  db.run("INSERT INTO spawn_history (cwd, last_spawn) VALUES ('/old', 1000), ('/older', 500);");
  db.close();

  const store = await StateStore.open(dbPath);

  registerTestCleanup(() => store.stop());

  const dirs = await store.collectSpawnDirs();

  expect(dirs).toStrictEqual([
    {
      cwd: '/old',
      grant: { target: 'local', targetIdentity: buildTargetIdentity('local-pty', {}) },
    },
    {
      cwd: '/older',
      grant: { target: 'local', targetIdentity: buildTargetIdentity('local-pty', {}) },
    },
  ]);
});

test('it round-trips a grok fleet row', async () => {
  const ctx = await setupTest();

  const entry = buildMockFleetEntry({ agent: 'grok' });

  await ctx.store.writeFleet([entry]);

  const fleet = await ctx.store.loadFleet();

  expect(fleet).toStrictEqual([entry]);
});

test('it round-trips an exited fleet row', async () => {
  const ctx = await setupTest();

  const archived = buildMockFleetEntry({ exited: true });
  const live = buildMockFleetEntry();

  await ctx.store.writeFleet([archived, live]);

  const fleet = await ctx.store.loadFleet();

  expect(fleet).toStrictEqual([archived, live]);
});

test('it round-trips a sub-session fleet row', async () => {
  const ctx = await setupTest();

  const wrangler = buildMockFleetEntry();
  const worker = buildMockFleetEntry({ parent: wrangler.sessionID });

  await ctx.store.writeFleet([wrangler, worker]);

  const fleet = await ctx.store.loadFleet();

  expect(fleet).toStrictEqual([wrangler, worker]);
});

test('it round-trips a fleet row with its model and effort', async () => {
  const ctx = await setupTest();

  const entry = buildMockFleetEntry({ model: 'opus[1m]', effort: 'xhigh' });

  await ctx.store.writeFleet([entry]);

  const fleet = await ctx.store.loadFleet();

  expect(fleet).toStrictEqual([entry]);
});

test('it round-trips a fleet row with what the operator asked of it and its host', async () => {
  const ctx = await setupTest();

  const sleeper = buildMockFleetEntry({
    sessionID: toSessionID('s-c1'),
    exited: true,
    desired: 'sleep',
    hostKey: toSessionID('s-c1'),
  });

  const helper = buildMockFleetEntry({
    parent: toSessionID('s-c1'),
    desired: 'stop',
    hostKey: toSessionID('s-c1'),
  });

  await ctx.store.writeFleet([sleeper, helper]);

  const fleet = await ctx.store.loadFleet();

  expect(fleet).toStrictEqual([sleeper, helper]);
});

test('it round-trips a fleet row with the auth revision its harness launched under', async () => {
  const ctx = await setupTest();

  const brokered = buildMockFleetEntry({ authRevision: 3 });
  const unbrokered = buildMockFleetEntry();

  await ctx.store.writeFleet([brokered, unbrokered]);

  const fleet = await ctx.store.loadFleet();

  expect(fleet).toStrictEqual([brokered, unbrokered]);
});

test('it round-trips a fleet row with its execution target and identity', async () => {
  const ctx = await setupTest();

  const remote = buildMockFleetEntry({ target: 'box', targetIdentity: 'imp:0123456789abcdef' });
  const untargeted = buildMockFleetEntry();

  await ctx.store.writeFleet([remote, untargeted]);

  const fleet = await ctx.store.loadFleet();

  expect(fleet).toStrictEqual([remote, untargeted]);
});

test('it adds parent to a fleet row that predates it', async () => {
  const tmp = setupTempDir('atc-store-');
  const dbPath = join(tmp.dir, 'state.db');

  const db = new Database(dbPath);

  registerTestCleanup(() => {
    db.close();
  });

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

  registerTestCleanup(() => store.stop());

  const fleet = await store.loadFleet();

  expect(fleet).toStrictEqual([
    {
      sessionID: expect.toSatisfy((id: string) =>
        /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/.test(id),
      ),
      name: 'old',
      cwd: '/x',
      agentSessionID: toAgentSessionID('c1'),
      agent: 'claude',
      lastAttachedAt: 555,
      exited: true,
    },
  ]);
});

test('it loads claude as the last-used agent before any write', async () => {
  const ctx = await setupTest();
  const agent = await ctx.store.loadLastUsedAgent();

  expect(agent).toBe('claude');
});

test('it loads the last-used agent a write recorded', async () => {
  const ctx = await setupTest();

  await ctx.store.writeLastUsedAgent('grok');

  const agent = await ctx.store.loadLastUsedAgent();

  expect(agent).toBe('grok');
});

test('it loads the later of two last-used agent writes', async () => {
  const ctx = await setupTest();

  await ctx.store.writeLastUsedAgent('grok');
  await ctx.store.writeLastUsedAgent('claude');

  const agent = await ctx.store.loadLastUsedAgent();

  expect(agent).toBe('claude');
});

test('it loads last-used agent from a reopened store', async () => {
  const ctx = await setupTest();

  await ctx.store.writeLastUsedAgent('grok');
  await ctx.store.stop();

  const second = await StateStore.open(ctx.dbPath);

  registerTestCleanup(() => second.stop());

  const agent = await second.loadLastUsedAgent();

  expect(agent).toBe('grok');
});

test('it renames the id column and defaults agent for a store written before both', async () => {
  const tmp = setupTempDir('atc-store-');
  const dbPath = join(tmp.dir, 'state.db');

  const db = new Database(dbPath);

  registerTestCleanup(() => {
    db.close();
  });

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

  registerTestCleanup(() => store.stop());

  const fleet = await store.loadFleet();

  const reader = new Database(dbPath, { readonly: true });

  registerTestCleanup(() => {
    reader.close();
  });

  const legacyColumn = reader.query('SELECT grp FROM fleet').all();

  expect(fleet).toStrictEqual([
    {
      sessionID: expect.toSatisfy((id: string) =>
        /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/.test(id),
      ),
      name: 'old',
      cwd: '/x',
      agentSessionID: toAgentSessionID('c1'),
      agent: 'claude',
    },
  ]);

  expect(legacyColumn).toStrictEqual([{ grp: 'squad-a' }]);
});

test('it adds pinned to a fleet row that predates it', async () => {
  const tmp = setupTempDir('atc-store-');
  const dbPath = join(tmp.dir, 'state.db');

  const db = new Database(dbPath);

  registerTestCleanup(() => {
    db.close();
  });

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

  registerTestCleanup(() => store.stop());

  const fleet = await store.loadFleet();

  expect(fleet).toStrictEqual([
    {
      sessionID: expect.toSatisfy((id: string) =>
        /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/.test(id),
      ),
      name: 'old',
      cwd: '/x',
      agentSessionID: toAgentSessionID('c1'),
      agent: 'grok',
      lastAttachedAt: 555,
      exited: true,
    },
  ]);
});

test('it adds the last-attached time to a fleet row that predates it', async () => {
  const tmp = setupTempDir('atc-store-');
  const dbPath = join(tmp.dir, 'state.db');

  const db = new Database(dbPath);

  registerTestCleanup(() => {
    db.close();
  });

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

  registerTestCleanup(() => store.stop());

  const fleet = await store.loadFleet();

  expect(fleet).toStrictEqual([
    {
      sessionID: expect.toSatisfy((id: string) =>
        /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/.test(id),
      ),
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
  const tmp = setupTempDir('atc-store-');
  const dbPath = join(tmp.dir, 'state.db');

  const db = new Database(dbPath);

  registerTestCleanup(() => {
    db.close();
  });

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

  registerTestCleanup(() => store.stop());

  const fleet = await store.loadFleet();

  expect(fleet).toStrictEqual([
    {
      sessionID: expect.toSatisfy((id: string) =>
        /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/.test(id),
      ),
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
  const tmp = setupTempDir('atc-store-');
  const dbPath = join(tmp.dir, 'state.db');

  const db = new Database(dbPath);

  registerTestCleanup(() => {
    db.close();
  });

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

  registerTestCleanup(() => store.stop());

  const fleet = await store.loadFleet();

  expect(fleet).toStrictEqual([
    {
      sessionID: expect.toSatisfy((id: string) =>
        /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/.test(id),
      ),
      name: 'old',
      cwd: '/x',
      agentSessionID: toAgentSessionID('c1'),
      agent: 'grok',
      pinned: true,
      lastAttachedAt: 555,
    },
  ]);
});

test('it runs every migration once on the first open of a legacy database', async () => {
  const tmp = setupTempDir('atc-store-');
  const dbPath = join(tmp.dir, 'state.db');

  const legacy = new Database(dbPath);

  registerTestCleanup(() => {
    legacy.close();
  });

  legacy.run(`
    CREATE TABLE fleet (
      claude_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      cwd TEXT NOT NULL
    );
  `);

  legacy.run("INSERT INTO fleet (claude_id, name, cwd) VALUES ('c1', 'first', '/x')");
  legacy.close();

  const store = await StateStore.open(dbPath);

  registerTestCleanup(() => store.stop());

  await store.stop();

  const ledger = new Database(dbPath, { readonly: true });

  registerTestCleanup(() => {
    ledger.close();
  });

  const names = ledger
    .query<{ name: string }, []>('SELECT name FROM kysely_migration ORDER BY name')
    .all()
    .map((row) => row.name);

  expect(names).toStrictEqual([
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
    '017_create_idempotency',
    '018_add_fleet_target',
    '019_add_idempotency_effect_target',
    '020_create_workspace_materialization',
    '021_add_fleet_lifecycle',
    '022_add_events_report_id',
    '023_add_events_report_text',
    '024_rebuild_spawn_history_keyed_by_target',
    '025_create_runtime_auth',
    '026_add_fleet_resume_interrupted_turns',
    '027_create_published_record',
    '028_rename_reports_to_notes_and_accepted_to_queued',
    '029_add_fleet_auth_revision',
    '030_add_messages_unanswered',
    '031_rebuild_fleet_without_unique_agent_session_id',
    '032_add_messages_answer_notice',
    '033_add_messages_sender_kind',
    '034_add_events_answer_text',
  ]);
});

test('it re-runs no migration when it reopens a migrated database', async () => {
  const tmp = setupTempDir('atc-store-');
  const dbPath = join(tmp.dir, 'state.db');

  const legacy = new Database(dbPath);

  registerTestCleanup(() => {
    legacy.close();
  });

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

  registerTestCleanup(() => first.stop());

  await first.stop();

  const ledger = new Database(dbPath);

  registerTestCleanup(() => {
    ledger.close();
  });

  ledger.run("UPDATE kysely_migration SET timestamp = 'sentinel'");

  const second = await StateStore.open(dbPath);

  registerTestCleanup(() => second.stop());

  await second.stop();

  const stamps = ledger
    .query<{ timestamp: string }, []>('SELECT timestamp FROM kysely_migration')
    .all()
    .map((row) => row.timestamp);

  expect(stamps).toStrictEqual(Array.from({ length: 34 }, () => 'sentinel'));
});

test('it keeps the fleet of a migrated database across a reopen', async () => {
  const tmp = setupTempDir('atc-store-');
  const dbPath = join(tmp.dir, 'state.db');

  const legacy = new Database(dbPath);

  registerTestCleanup(() => {
    legacy.close();
  });

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

  registerTestCleanup(() => first.stop());

  const added = buildMockFleetEntry();

  await first.writeFleet([...(await first.loadFleet()), added]);
  await first.stop();

  const second = await StateStore.open(dbPath);

  registerTestCleanup(() => second.stop());

  const fleet = await second.loadFleet();

  expect(fleet).toStrictEqual([
    {
      sessionID: expect.toSatisfy((id: string) =>
        /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/.test(id),
      ),
      name: 'first',
      cwd: '/x',
      agentSessionID: toAgentSessionID('c1'),
      agent: 'claude',
    },
    added,
  ]);
});

test('it ends a fresh database at the same fleet schema as a fully migrated old one', async () => {
  const tmp = setupTempDir('atc-store-');
  const freshPath = join(tmp.dir, 'fresh.db');
  const oldPath = join(tmp.dir, 'old.db');

  const old = new Database(oldPath);

  registerTestCleanup(() => {
    old.close();
  });

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

  registerTestCleanup(() => freshStore.stop());

  const oldStore = await StateStore.open(oldPath);

  registerTestCleanup(() => oldStore.stop());

  await freshStore.stop();
  await oldStore.stop();

  const freshDB = new Database(freshPath, { readonly: true });

  registerTestCleanup(() => {
    freshDB.close();
  });

  const oldDB = new Database(oldPath, { readonly: true });

  registerTestCleanup(() => {
    oldDB.close();
  });

  const [freshSchema, oldSchema] = [freshDB, oldDB].map((db) =>
    db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name)
      .toSorted()
      .map((table) => ({
        table,
        columns: db
          .query<{ name: string; type: string; notnull: number; dflt_value: unknown }, []>(
            `PRAGMA table_info(${table})`,
          )
          .all()
          .map((column) => ({
            name: column.name,
            type: column.type,
            notnull: column.notnull,
            dflt_value: column.dflt_value,
          }))
          .toSorted((a, b) => a.name.localeCompare(b.name)),
      })),
  );

  expect(freshSchema).toStrictEqual(oldSchema);
});

test('it loads claude as the last-used agent from a database that predates prefs', async () => {
  const tmp = setupTempDir('atc-store-');
  const dbPath = join(tmp.dir, 'state.db');

  const db = new Database(dbPath);

  registerTestCleanup(() => {
    db.close();
  });

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

  registerTestCleanup(() => store.stop());

  const agent = await store.loadLastUsedAgent();

  expect(agent).toBe('claude');
});

test('it records a last-used agent in a database that predates prefs', async () => {
  const tmp = setupTempDir('atc-store-');
  const dbPath = join(tmp.dir, 'state.db');

  const db = new Database(dbPath);

  registerTestCleanup(() => {
    db.close();
  });

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

  registerTestCleanup(() => store.stop());

  await store.writeLastUsedAgent('grok');

  const agent = await store.loadLastUsedAgent();

  expect(agent).toBe('grok');
});

test("it round-trips a fleet row's prompt, result, and transcript path", async () => {
  const ctx = await setupTest();

  const entry = buildMockFleetEntry({
    prompt: 'fix the auth bug',
    result: 'All green.',
    transcriptPath: '/t/c1.jsonl',
  });

  await ctx.store.writeFleet([entry]);

  const stored = await ctx.store.loadFleet();

  expect(stored).toStrictEqual([entry]);
});

test('it records a hook event with its normalized kind and detail', async () => {
  const ctx = await setupTest();

  await ctx.store.recordEvent(
    { atcId: toSessionID('s1'), event: 'Stop', payload: { session_id: 'c1' } },
    { kind: 'turn-done', detail: 'all green' },
  );

  const events = await ctx.store.collectLatestEvents(10);

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
  const ctx = await setupTest();

  await ctx.store.recordEvent(
    { atcId: toSessionID('s1'), event: 'Notification', payload: { message: 'needs permission' } },
    { kind: 'needs-input' },
  );

  const events = await ctx.store.collectLatestEvents(10);

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
  const ctx = await setupTest();

  await ctx.store.recordEvent({ atcId: toSessionID('s1'), event: 'Statusline', payload: {} });

  await ctx.store.recordEvent(
    { atcId: toSessionID('s1'), event: 'Other', payload: {} },
    { kind: 'heartbeat' },
  );

  await ctx.store.recordEvent(
    { atcId: toSessionID('s1'), event: 'SessionStart', payload: {} },
    { kind: 'started' },
  );

  const events = await ctx.store.collectLatestEvents(10);

  expect(events).toStrictEqual([
    {
      id: expect.toBeNumber(),
      at: expect.toBeNumber(),
      atcID: toSessionID('s1'),
      agentSessionID: null,
      kind: 'started',
      detail: null,
    },
  ]);
});

test('it collects events after an id oldest first, up to the limit', async () => {
  const ctx = await setupTest();

  await ctx.store.recordEvent(
    { atcId: toSessionID('s1'), event: 'SessionStart', payload: {} },
    { kind: 'started', detail: 'one' },
  );

  await ctx.store.recordEvent(
    { atcId: toSessionID('s1'), event: 'Stop', payload: {} },
    { kind: 'turn-done', detail: 'two' },
  );

  await ctx.store.recordEvent(
    { atcId: toSessionID('s1'), event: 'SessionEnd', payload: {} },
    { kind: 'ended', detail: 'three' },
  );

  const [first] = await ctx.store.collectLatestEvents(10);

  invariant(first !== undefined, 'expected events');

  const after = await ctx.store.collectEventsAfter(first.id, 1);

  expect(after).toStrictEqual([
    {
      id: expect.toBeNumber(),
      at: expect.toBeNumber(),
      atcID: toSessionID('s1'),
      agentSessionID: null,
      kind: 'turn-done',
      detail: 'two',
    },
  ]);
});

test('it collects the latest events oldest first', async () => {
  const ctx = await setupTest();

  await ctx.store.recordEvent(
    { atcId: toSessionID('s1'), event: 'SessionStart', payload: {} },
    { kind: 'started', detail: 'one' },
  );

  await ctx.store.recordEvent(
    { atcId: toSessionID('s1'), event: 'Stop', payload: {} },
    { kind: 'turn-done', detail: 'two' },
  );

  await ctx.store.recordEvent(
    { atcId: toSessionID('s1'), event: 'SessionEnd', payload: {} },
    { kind: 'ended', detail: 'three' },
  );

  const latest = await ctx.store.collectLatestEvents(2);

  expect(latest).toStrictEqual([
    {
      id: expect.toBeNumber(),
      at: expect.toBeNumber(),
      atcID: toSessionID('s1'),
      agentSessionID: null,
      kind: 'turn-done',
      detail: 'two',
    },
    {
      id: expect.toBeNumber(),
      at: expect.toBeNumber(),
      atcID: toSessionID('s1'),
      agentSessionID: null,
      kind: 'ended',
      detail: 'three',
    },
  ]);
});

test("it loads a session's last activity time by its agent session id", async () => {
  const ctx = await setupTest();

  const before = Date.now();

  await ctx.store.recordEvent(
    { atcId: toSessionID('s-old'), event: 'Stop', payload: { session_id: 'c1' } },
    { kind: 'turn-done' },
  );

  const at = await ctx.store.loadLastActivityAt(toSessionID('s-new'), toAgentSessionID('c1'));

  expect(at).toBeWithin(before, Date.now() + 1);
});

test('it loads no last activity time for a session that never reported', async () => {
  const ctx = await setupTest();
  const at = await ctx.store.loadLastActivityAt(toSessionID('s1'), undefined);

  expect(at).toBeNull();
});

test('it updates one fleet row without touching its siblings', async () => {
  const ctx = await setupTest();

  const updated = buildMockFleetEntry();
  const sibling = buildMockFleetEntry();

  await ctx.store.writeFleet([updated, sibling]);

  await ctx.store.updateFleetEntry(updated.sessionID, {
    result: 'done',
    transcriptPath: '/a.jsonl',
  });

  const fleet = await ctx.store.loadFleet();

  expect(fleet).toStrictEqual([
    { ...updated, result: 'done', transcriptPath: '/a.jsonl' },
    sibling,
  ]);
});

test('it ignores an update for a session with no fleet row', async () => {
  const ctx = await setupTest();

  await ctx.store.updateFleetEntry(toSessionID('ghost'), { result: 'done' });

  const fleet = await ctx.store.loadFleet();

  expect(fleet).toStrictEqual([]);
});

test('it serves the trail read after an id from an index', async () => {
  const ctx = await setupTest();

  await ctx.store.collectEventsAfter(5, 5);

  const query = ctx.queries.at(-1);

  invariant(query !== undefined, 'the store ran no query');

  const plan = readQueryPlan(ctx.dbPath, query);

  expect(plan).toInclude('USING INDEX events_trail');
});

test('it serves the latest trail read from an index', async () => {
  const ctx = await setupTest();

  await ctx.store.collectLatestEvents(5);

  const query = ctx.queries.at(-1);

  invariant(query !== undefined, 'the store ran no query');

  const plan = readQueryPlan(ctx.dbPath, query);

  expect(plan).toInclude('USING INDEX events_trail');
});

test('it serves the last activity lookup from an index on each id', async () => {
  const ctx = await setupTest();

  await ctx.store.loadLastActivityAt(toSessionID('s1'), toAgentSessionID('c1'));

  const query = ctx.queries.at(-1);

  invariant(query !== undefined, 'the store ran no query');

  const plan = readQueryPlan(ctx.dbPath, query);

  expect(plan).toInclude('USING INDEX events_atc_id_ts');
  expect(plan).toInclude('USING INDEX events_session_id_ts');
});

test('it removes trail rows recorded before the cutoff', async () => {
  const ctx = await setupTest();

  await ctx.store.writeFleet([
    buildMockFleetEntry({ sessionID: toSessionID('s1'), agentSessionID: toAgentSessionID('c1') }),
  ]);

  await ctx.store.recordEvent(
    { atcId: toSessionID('s1'), event: 'SessionStart', payload: { session_id: 'c1' } },
    { kind: 'started' },
    Date.parse('2026-01-01T00:00:00.000Z'),
  );

  await ctx.store.recordEvent(
    { atcId: toSessionID('s1'), event: 'Stop', payload: { session_id: 'c1' } },
    { kind: 'turn-done' },
    Date.parse('2026-02-10T00:00:00.000Z'),
  );

  await ctx.store.removeExpiredEvents(Date.parse('2026-01-31T00:00:00.000Z'));

  const db = new Database(ctx.dbPath, { readonly: true });

  registerTestCleanup(() => {
    db.close();
  });

  const rows = db.query<{ ts: string; kind: string }, []>('SELECT ts, kind FROM events').all();

  expect(rows).toStrictEqual([{ ts: '2026-02-10T00:00:00.000Z', kind: 'turn-done' }]);
});

test('it keeps the newest row of a fleet session recorded before the cutoff', async () => {
  const ctx = await setupTest();

  await ctx.store.writeFleet([
    buildMockFleetEntry({ sessionID: toSessionID('s1'), agentSessionID: toAgentSessionID('c1') }),
  ]);

  await ctx.store.recordEvent(
    { atcId: toSessionID('s1'), event: 'SessionStart', payload: { session_id: 'c1' } },
    { kind: 'started' },
    Date.parse('2026-01-01T00:00:00.000Z'),
  );

  await ctx.store.recordEvent(
    { atcId: toSessionID('s1'), event: 'Stop', payload: { session_id: 'c1' } },
    { kind: 'turn-done' },
    Date.parse('2026-01-02T00:00:00.000Z'),
  );

  await ctx.store.removeExpiredEvents(Date.parse('2026-01-31T00:00:00.000Z'));

  const db = new Database(ctx.dbPath, { readonly: true });

  registerTestCleanup(() => {
    db.close();
  });

  const rows = db.query<{ ts: string; kind: string }, []>('SELECT ts, kind FROM events').all();

  expect(rows).toStrictEqual([{ ts: '2026-01-02T00:00:00.000Z', kind: 'turn-done' }]);
});

test('it keeps the newest row under an agent session id that an earlier atc id recorded', async () => {
  const ctx = await setupTest();

  await ctx.store.writeFleet([
    buildMockFleetEntry({
      sessionID: toSessionID('s-new'),
      agentSessionID: toAgentSessionID('c1'),
    }),
  ]);

  await ctx.store.recordEvent(
    { atcId: toSessionID('s-old'), event: 'SessionStart', payload: { session_id: 'c1' } },
    { kind: 'started' },
    Date.parse('2026-01-01T00:00:00.000Z'),
  );

  await ctx.store.recordEvent(
    { atcId: toSessionID('s-old'), event: 'Stop', payload: { session_id: 'c1' } },
    { kind: 'turn-done' },
    Date.parse('2026-01-02T00:00:00.000Z'),
  );

  await ctx.store.removeExpiredEvents(Date.parse('2026-01-31T00:00:00.000Z'));

  const db = new Database(ctx.dbPath, { readonly: true });

  registerTestCleanup(() => {
    db.close();
  });

  const rows = db.query<{ atc_id: string; ts: string }, []>('SELECT atc_id, ts FROM events').all();

  expect(rows).toStrictEqual([{ atc_id: 's-old', ts: '2026-01-02T00:00:00.000Z' }]);
});

test('it removes the newest row recorded before the cutoff of a session no fleet row holds', async () => {
  const ctx = await setupTest();

  await ctx.store.recordEvent(
    { atcId: toSessionID('s-gone'), event: 'Stop', payload: { session_id: 'c-gone' } },
    { kind: 'turn-done' },
    Date.parse('2026-01-02T00:00:00.000Z'),
  );

  await ctx.store.removeExpiredEvents(Date.parse('2026-01-31T00:00:00.000Z'));

  const db = new Database(ctx.dbPath, { readonly: true });

  registerTestCleanup(() => {
    db.close();
  });

  const rows = db.query<{ id: number }, []>('SELECT id FROM events').all();

  expect(rows).toStrictEqual([]);
});

test('it removes heartbeats and unclassified events after the cutoff except the newest row', async () => {
  const ctx = await setupTest();

  await ctx.store.recordEvent(
    { atcId: toSessionID('s1'), event: 'SessionStart', payload: {} },
    { kind: 'started' },
    Date.parse('2026-02-01T00:00:00.000Z'),
  );

  await ctx.store.recordEvent(
    { atcId: toSessionID('s1'), event: 'Statusline', payload: {} },
    { kind: 'heartbeat' },
    Date.parse('2026-02-02T00:00:00.000Z'),
  );

  await ctx.store.recordEvent(
    { atcId: toSessionID('s1'), event: 'Other', payload: {} },
    null,
    Date.parse('2026-02-03T00:00:00.000Z'),
  );

  await ctx.store.recordEvent(
    { atcId: toSessionID('s1'), event: 'Statusline', payload: {} },
    { kind: 'heartbeat' },
    Date.parse('2026-02-04T00:00:00.000Z'),
  );

  await ctx.store.removeExpiredEvents(Date.parse('2026-01-31T00:00:00.000Z'));

  const db = new Database(ctx.dbPath, { readonly: true });

  registerTestCleanup(() => {
    db.close();
  });

  const rows = db.query<{ ts: string; kind: string }, []>('SELECT ts, kind FROM events').all();

  expect(rows).toStrictEqual([
    { ts: '2026-02-01T00:00:00.000Z', kind: 'started' },
    { ts: '2026-02-04T00:00:00.000Z', kind: 'heartbeat' },
  ]);
});

test('it never removes a trail row recorded after the cutoff', async () => {
  const ctx = await setupTest();

  await ctx.store.recordEvent(
    { atcId: toSessionID('s1'), event: 'SessionStart', payload: {} },
    { kind: 'started' },
    Date.parse('2026-02-01T00:00:00.000Z'),
  );

  await ctx.store.recordEvent(
    { atcId: toSessionID('s2'), event: 'Notification', payload: {} },
    { kind: 'needs-input', detail: 'approve the migration' },
    Date.parse('2026-02-02T00:00:00.000Z'),
  );

  await ctx.store.recordEvent(
    { atcId: toSessionID('s1'), event: 'Stop', payload: {} },
    { kind: 'turn-done' },
    Date.parse('2026-02-03T00:00:00.000Z'),
  );

  await ctx.store.removeExpiredEvents(Date.parse('2026-01-31T00:00:00.000Z'));

  const db = new Database(ctx.dbPath, { readonly: true });

  registerTestCleanup(() => {
    db.close();
  });

  const rows = db
    .query<{ atc_id: string; kind: string }, []>('SELECT atc_id, kind FROM events')
    .all();

  expect(rows).toStrictEqual([
    { atc_id: 's1', kind: 'started' },
    { atc_id: 's2', kind: 'needs-input' },
    { atc_id: 's1', kind: 'turn-done' },
  ]);
});

test("it loads a session's last activity time unchanged after a prune", async () => {
  const ctx = await setupTest();

  await ctx.store.writeFleet([
    buildMockFleetEntry({ sessionID: toSessionID('s1'), agentSessionID: toAgentSessionID('c1') }),
  ]);

  await ctx.store.recordEvent(
    { atcId: toSessionID('s1'), event: 'SessionStart', payload: { session_id: 'c1' } },
    { kind: 'started' },
    Date.parse('2026-01-01T00:00:00.000Z'),
  );

  await ctx.store.recordEvent(
    { atcId: toSessionID('s1'), event: 'Statusline', payload: { session_id: 'c1' } },
    { kind: 'heartbeat' },
    Date.parse('2026-01-05T00:00:00.000Z'),
  );

  await ctx.store.removeExpiredEvents(Date.parse('2026-01-31T00:00:00.000Z'));

  const at = await ctx.store.loadLastActivityAt(toSessionID('s1'), toAgentSessionID('c1'));

  expect(at).toBe(Date.parse('2026-01-05T00:00:00.000Z'));
});

test('it collects the rows after a cursor that a prune keeps', async () => {
  const ctx = await setupTest();

  await ctx.store.writeFleet([
    buildMockFleetEntry({ sessionID: toSessionID('s1'), agentSessionID: toAgentSessionID('c1') }),
  ]);

  await ctx.store.recordEvent(
    { atcId: toSessionID('s1'), event: 'SessionStart', payload: { session_id: 'c1' } },
    { kind: 'started' },
    Date.parse('2026-01-01T00:00:00.000Z'),
  );

  await ctx.store.recordEvent(
    { atcId: toSessionID('s1'), event: 'Stop', payload: { session_id: 'c1' } },
    { kind: 'turn-done', detail: 'old turn' },
    Date.parse('2026-01-02T00:00:00.000Z'),
  );

  await ctx.store.recordEvent(
    { atcId: toSessionID('s1'), event: 'Stop', payload: { session_id: 'c1' } },
    { kind: 'turn-done', detail: 'new turn' },
    Date.parse('2026-02-10T00:00:00.000Z'),
  );

  const [latest] = await ctx.store.collectLatestEvents(1);
  const [cursor] = await ctx.store.collectEventsAfter(0, 1);

  invariant(latest !== undefined && cursor !== undefined, 'expected events');

  await ctx.store.removeExpiredEvents(Date.parse('2026-01-31T00:00:00.000Z'));

  const after = await ctx.store.collectEventsAfter(cursor.id, 10);

  expect(after).toStrictEqual([
    {
      id: latest.id,
      at: Date.parse('2026-02-10T00:00:00.000Z'),
      atcID: toSessionID('s1'),
      agentSessionID: toAgentSessionID('c1'),
      kind: 'turn-done',
      detail: 'new turn',
    },
  ]);
});

test('it finds the newest row of each id from an index when it removes expired events', async () => {
  const ctx = await setupTest();

  await ctx.store.removeExpiredEvents(Date.parse('2026-01-31T00:00:00.000Z'));

  const query = ctx.queries.at(-1);

  invariant(query !== undefined, 'the store ran no query');

  const plan = readQueryPlan(ctx.dbPath, query);

  expect(plan).toInclude('USING COVERING INDEX events_atc_id_ts');
  expect(plan).toInclude('USING COVERING INDEX events_session_id_ts');
});

test('it lists a queued message as pending for the session it was sent to', async () => {
  const ctx = await setupTest();

  const record = buildMockMessageRecord();

  await ctx.store.writeMessage(record);

  const pending = await ctx.store.collectPendingMessages({ atcID: record.atcID });

  expect(pending).toStrictEqual([record]);
});

test('it lists pending messages in the order they were sent', async () => {
  const ctx = await setupTest();

  const first = buildMockMessageRecord({
    id: toMessageID('m-z'),
    atcID: toSessionID('s1'),
    sentAt: 1000,
  });

  const second = buildMockMessageRecord({
    id: toMessageID('m-a'),
    atcID: toSessionID('s1'),
    sentAt: 1000,
  });

  const third = buildMockMessageRecord({
    id: toMessageID('m-m'),
    atcID: toSessionID('s1'),
    sentAt: 1001,
  });

  await ctx.store.writeMessage(first);
  await ctx.store.writeMessage(second);
  await ctx.store.writeMessage(third);

  const pending = await ctx.store.collectPendingMessages({ atcID: toSessionID('s1') });

  expect(pending).toStrictEqual([first, second, third]);
});

test('it finds pending messages by agent session id under a new atc id', async () => {
  const ctx = await setupTest();

  const record = buildMockMessageRecord({
    atcID: toSessionID('s1'),
    agentSessionID: toAgentSessionID('a1'),
  });

  await ctx.store.writeMessage(record);

  const pending = await ctx.store.collectPendingMessages({
    atcID: toSessionID('s2'),
    agentSessionID: toAgentSessionID('a1'),
  });

  expect(pending).toStrictEqual([record]);
});

test('it lists queued and delivered messages as unsettled, oldest first', async () => {
  const ctx = await setupTest();

  const delivered = buildMockMessageRecord({
    id: toMessageID('m-delivered'),
    atcID: toSessionID('s1'),
    sentAt: 1000,
  });

  const queued = buildMockMessageRecord({
    id: toMessageID('m-queued'),
    atcID: toSessionID('s1'),
    sentAt: 1001,
  });

  const answered = buildMockMessageRecord({
    id: toMessageID('m-answered'),
    atcID: toSessionID('s1'),
    sentAt: 1002,
  });

  await ctx.store.writeMessage(delivered);
  await ctx.store.writeMessage(queued);
  await ctx.store.writeMessage(answered);
  await ctx.store.updateMessageDelivered(delivered.id, { atcID: toSessionID('s1') }, 2000);
  await ctx.store.updateMessagesAnswered([answered.id], { atcID: toSessionID('s1') }, 'ok', 2000);

  const unsettled = await ctx.store.collectUnsettledMessages({ atcID: toSessionID('s1') });

  expect(unsettled).toStrictEqual([
    { ...delivered, status: 'delivered', deliveredAt: 2000 },
    queued,
  ]);
});

test('it moves a queued message to delivered', async () => {
  const ctx = await setupTest();

  const record = buildMockMessageRecord();

  await ctx.store.writeMessage(record);

  const delivered = await ctx.store.updateMessageDelivered(
    record.id,
    { atcID: record.atcID },
    2000,
  );

  expect(delivered).toStrictEqual({ ...record, status: 'delivered', deliveredAt: 2000 });
});

test('it refuses to deliver a message a second time', async () => {
  const ctx = await setupTest();

  const record = buildMockMessageRecord();

  await ctx.store.writeMessage(record);
  await ctx.store.updateMessageDelivered(record.id, { atcID: record.atcID }, 2000);

  const second = await ctx.store.updateMessageDelivered(record.id, { atcID: record.atcID }, 3000);

  expect(second).toBeNull();
});

test('it drops a delivered message from the pending list', async () => {
  const ctx = await setupTest();

  const record = buildMockMessageRecord();

  await ctx.store.writeMessage(record);
  await ctx.store.updateMessageDelivered(record.id, { atcID: record.atcID }, 2000);

  const pending = await ctx.store.collectPendingMessages({ atcID: record.atcID });

  expect(pending).toStrictEqual([]);
});

test('it moves a delivered message to answered with the final text', async () => {
  const ctx = await setupTest();

  const record = buildMockMessageRecord();

  await ctx.store.writeMessage(record);
  await ctx.store.updateMessageDelivered(record.id, { atcID: record.atcID }, 2000);

  const answered = await ctx.store.updateMessagesAnswered(
    [record.id],
    { atcID: record.atcID },
    'done',
    3000,
  );

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

test('it answers a queued message that was never acked', async () => {
  const ctx = await setupTest();

  const record = buildMockMessageRecord();

  await ctx.store.writeMessage(record);

  const answered = await ctx.store.updateMessagesAnswered(
    [record.id],
    { atcID: record.atcID },
    'done',
    3000,
  );

  expect(answered).toStrictEqual([
    {
      ...record,
      status: 'answered',
      answeredAt: 3000,
      answer: 'done',
    },
  ]);
});

test('it moves a delivered message to unanswered with the reason and turn', async () => {
  const ctx = await setupTest();

  const record = buildMockMessageRecord();

  await ctx.store.writeMessage(record);
  await ctx.store.updateMessageDelivered(record.id, { atcID: record.atcID }, 2000);

  const marked = await ctx.store.updateMessagesUnanswered(
    [record.id],
    { atcID: record.atcID },
    'interrupted',
    3000,
    't1',
  );

  expect(marked).toStrictEqual([
    {
      ...record,
      status: 'unanswered',
      deliveredAt: 2000,
      unansweredAt: 3000,
      unansweredReason: 'interrupted',
      turn: 't1',
    },
  ]);
});

test('it refuses a later answer for an unanswered message', async () => {
  const ctx = await setupTest();

  const record = buildMockMessageRecord();

  await ctx.store.writeMessage(record);
  await ctx.store.updateMessagesUnanswered([record.id], { atcID: record.atcID }, 'error', 3000);

  const answered = await ctx.store.updateMessagesAnswered(
    [record.id],
    { atcID: record.atcID },
    'done',
    4000,
  );

  expect(answered).toStrictEqual([]);
});

test('it keeps an unanswered message unanswered after a refused answer', async () => {
  const ctx = await setupTest();

  const record = buildMockMessageRecord();

  await ctx.store.writeMessage(record);
  await ctx.store.updateMessagesUnanswered([record.id], { atcID: record.atcID }, 'error', 3000);
  await ctx.store.updateMessagesAnswered([record.id], { atcID: record.atcID }, 'done', 4000);

  const found = await ctx.store.findMessage(record.id, { atcID: record.atcID });

  expect(found?.status).toBe('unanswered');
});

test('it refuses to mark an answered message unanswered', async () => {
  const ctx = await setupTest();

  const record = buildMockMessageRecord();

  await ctx.store.writeMessage(record);
  await ctx.store.updateMessagesAnswered([record.id], { atcID: record.atcID }, 'done', 3000);

  const marked = await ctx.store.updateMessagesUnanswered(
    [record.id],
    { atcID: record.atcID },
    'interrupted',
    4000,
  );

  expect(marked).toStrictEqual([]);
});

test('it refuses to mark a message unanswered for another session', async () => {
  const ctx = await setupTest();

  const record = buildMockMessageRecord({ atcID: toSessionID('s1') });

  await ctx.store.writeMessage(record);

  const marked = await ctx.store.updateMessagesUnanswered(
    [record.id],
    { atcID: toSessionID('s2') },
    'interrupted',
    2000,
  );

  expect(marked).toStrictEqual([]);
});

test('it marks every delivered message of a session unanswered with the given reason', async () => {
  const ctx = await setupTest();

  const record = buildMockMessageRecord({ atcID: toSessionID('s1') });

  await ctx.store.writeMessage(record);
  await ctx.store.updateMessageDelivered(record.id, { atcID: toSessionID('s1') }, 2000);

  const marked = await ctx.store.updateDeliveredMessagesUnanswered(
    { atcID: toSessionID('s1') },
    'session_ended',
    3000,
  );

  expect(marked).toStrictEqual([
    {
      ...record,
      status: 'unanswered',
      deliveredAt: 2000,
      unansweredAt: 3000,
      unansweredReason: 'session_ended',
    },
  ]);
});

test('it stores the sender session of a message', async () => {
  const ctx = await setupTest();

  const record = buildMockMessageRecord({ senderSession: toSessionID('sender') });

  await ctx.store.writeMessage(record);

  const stored = await ctx.store.findMessageByID(record.id);

  expect(stored).toStrictEqual(record);
});

test.each([
  [{ kind: 'connector', client: 'client-7', name: 'Lantern Notes' }],
  [{ kind: 'session', session: 'harbor-1', name: 'harbor-refactor' }],
  [{ kind: 'owner', name: 'owner' }],
] as const)('it stores the typed sender of a message: %o', async (sender) => {
  const ctx = await setupTest();

  const record = buildMockMessageRecord({ from: sender.name, sender });

  await ctx.store.writeMessage(record);

  const stored = await ctx.store.findMessageByID(record.id);

  expect(stored).toStrictEqual(record);
});

test('it reads a message stored without a sender kind with its sender name alone', async () => {
  const ctx = await setupTest();

  const db = new Database(ctx.dbPath);

  registerTestCleanup(() => {
    db.close();
  });

  db.run(
    "INSERT INTO messages (id, atc_id, sender, text, status, sent_at) VALUES ('m-old', 's1', 'mcp', 'hi', 'queued', 1)",
  );

  const stored = await ctx.store.findMessageByID(toMessageID('m-old'));

  expect(stored).toStrictEqual({
    id: toMessageID('m-old'),
    atcID: toSessionID('s1'),
    from: 'mcp',
    text: 'hi',
    status: 'queued',
    sentAt: 1,
  });
});

test('it queues the answer notice of a message in the statement that answers it', async () => {
  const ctx = await setupTest();

  const record = buildMockMessageRecord({ senderSession: toSessionID('sender') });

  await ctx.store.writeMessage(record);

  const answered = await ctx.store.updateMessagesAnswered(
    [record.id],
    { atcID: record.atcID },
    'done',
    3000,
  );

  expect(answered).toStrictEqual([
    {
      ...record,
      status: 'answered',
      answeredAt: 3000,
      answer: 'done',
      noticeQueuedAt: 3000,
    },
  ]);
});

test('it queues the answer notice of a message in the statement that marks it unanswered', async () => {
  const ctx = await setupTest();

  const record = buildMockMessageRecord({ senderSession: toSessionID('sender') });

  await ctx.store.writeMessage(record);

  const unanswered = await ctx.store.updateMessagesUnanswered(
    [record.id],
    { atcID: record.atcID },
    'interrupted',
    3000,
  );

  expect(unanswered).toStrictEqual([
    {
      ...record,
      status: 'unanswered',
      unansweredAt: 3000,
      unansweredReason: 'interrupted',
      noticeQueuedAt: 3000,
    },
  ]);
});

test('it queues the answer notice of a delivered message in the statement that ends its session', async () => {
  const ctx = await setupTest();

  const record = buildMockMessageRecord({ senderSession: toSessionID('sender') });

  await ctx.store.writeMessage(record);
  await ctx.store.updateMessageDelivered(record.id, { atcID: record.atcID }, 2000);

  const unanswered = await ctx.store.updateDeliveredMessagesUnanswered(
    { atcID: record.atcID },
    'session_ended',
    3000,
  );

  expect(unanswered).toStrictEqual([
    {
      ...record,
      status: 'unanswered',
      deliveredAt: 2000,
      unansweredAt: 3000,
      unansweredReason: 'session_ended',
      noticeQueuedAt: 3000,
    },
  ]);
});

test('it queues no answer notice for a message without a sender session', async () => {
  const ctx = await setupTest();

  const record = buildMockMessageRecord();

  await ctx.store.writeMessage(record);

  const answered = await ctx.store.updateMessagesAnswered(
    [record.id],
    { atcID: record.atcID },
    'done',
    3000,
  );

  expect(answered).toStrictEqual([
    { ...record, status: 'answered', answeredAt: 3000, answer: 'done' },
  ]);
});

test('it keeps the answer notice of a message answered before a store reopen', async () => {
  const ctx = await setupTest();

  const sender = toSessionID('sender');
  const record = buildMockMessageRecord({ senderSession: sender });

  await ctx.store.writeMessage(record);
  await ctx.store.updateMessagesAnswered([record.id], { atcID: record.atcID }, 'done', 3000);
  await ctx.store.stop();

  const second = await StateStore.open(ctx.dbPath);

  registerTestCleanup(() => second.stop());

  const pending = await second.collectPendingNotices(sender);

  expect(pending).toStrictEqual([
    {
      ...record,
      status: 'answered',
      answeredAt: 3000,
      answer: 'done',
      noticeQueuedAt: 3000,
    },
  ]);
});

test('it queues no second answer notice for a message answered again after a store reopen', async () => {
  const ctx = await setupTest();

  const sender = toSessionID('sender');
  const record = buildMockMessageRecord({ senderSession: sender });

  await ctx.store.writeMessage(record);
  await ctx.store.updateMessagesAnswered([record.id], { atcID: record.atcID }, 'done', 3000);
  await ctx.store.stop();

  const second = await StateStore.open(ctx.dbPath);

  registerTestCleanup(() => second.stop());

  const again = await second.updateMessagesAnswered(
    [record.id],
    { atcID: record.atcID },
    'done again',
    4000,
  );

  const pending = await second.collectPendingNotices(sender);

  expect(again).toStrictEqual([]);
  expect(pending.map((x) => [x.id, x.noticeQueuedAt])).toStrictEqual([[record.id, 3000]]);
});

test('it lists the queued answer notices of a sender until its tap takes them', async () => {
  const ctx = await setupTest();

  const sender = toSessionID('sender');
  const first = buildMockMessageRecord({ id: toMessageID('m1'), senderSession: sender });
  const second = buildMockMessageRecord({ id: toMessageID('m2'), senderSession: sender });

  const other = buildMockMessageRecord({
    id: toMessageID('m3'),
    senderSession: toSessionID('other'),
  });

  await ctx.store.writeMessage(first);
  await ctx.store.writeMessage(second);
  await ctx.store.writeMessage(other);

  await ctx.store.updateMessagesUnanswered(
    [second.id],
    { atcID: second.atcID },
    'interrupted',
    4000,
  );

  await ctx.store.updateMessagesUnanswered([first.id], { atcID: first.atcID }, 'interrupted', 5000);
  await ctx.store.updateMessagesUnanswered([other.id], { atcID: other.atcID }, 'interrupted', 5000);

  const pending = await ctx.store.collectPendingNotices(sender);

  expect(pending.map((x) => x.id)).toStrictEqual([second.id, first.id]);

  const delivered = await ctx.store.updateNoticeDelivered(second.id, sender, 6000);

  expect(delivered?.noticeDeliveredAt).toBe(6000);

  const after = await ctx.store.collectPendingNotices(sender);

  expect(after.map((x) => x.id)).toStrictEqual([first.id]);
});

test('it refuses to deliver an answer notice twice or to another sender', async () => {
  const ctx = await setupTest();

  const sender = toSessionID('sender');
  const record = buildMockMessageRecord({ senderSession: sender });

  await ctx.store.writeMessage(record);
  await ctx.store.updateMessagesAnswered([record.id], { atcID: record.atcID }, 'done', 3000);

  const byOther = await ctx.store.updateNoticeDelivered(record.id, toSessionID('other'), 5000);
  const first = await ctx.store.updateNoticeDelivered(record.id, sender, 5000);
  const second = await ctx.store.updateNoticeDelivered(record.id, sender, 6000);

  expect(byOther).toBeNull();
  expect(first?.noticeDeliveredAt).toBe(5000);
  expect(second).toBeNull();
});

test('it keeps a queued message queued when its session ends', async () => {
  const ctx = await setupTest();

  const record = buildMockMessageRecord({ atcID: toSessionID('s1') });

  await ctx.store.writeMessage(record);

  const marked = await ctx.store.updateDeliveredMessagesUnanswered(
    { atcID: toSessionID('s1') },
    'session_ended',
    3000,
  );

  expect(marked).toStrictEqual([]);
});

test('it keeps an answered message answered when its session ends', async () => {
  const ctx = await setupTest();

  const record = buildMockMessageRecord({ atcID: toSessionID('s1') });

  await ctx.store.writeMessage(record);
  await ctx.store.updateMessagesAnswered([record.id], { atcID: toSessionID('s1') }, 'done', 2000);

  const marked = await ctx.store.updateDeliveredMessagesUnanswered(
    { atcID: toSessionID('s1') },
    'session_ended',
    3000,
  );

  expect(marked).toStrictEqual([]);
});

test('it never marks a delivered message of another session when a session ends', async () => {
  const ctx = await setupTest();

  const record = buildMockMessageRecord({ atcID: toSessionID('s2') });

  await ctx.store.writeMessage(record);
  await ctx.store.updateMessageDelivered(record.id, { atcID: toSessionID('s2') }, 2000);

  const marked = await ctx.store.updateDeliveredMessagesUnanswered(
    { atcID: toSessionID('s1') },
    'session_ended',
    3000,
  );

  expect(marked).toStrictEqual([]);
});

test('it refuses to deliver a message owned by another session', async () => {
  const ctx = await setupTest();

  const record = buildMockMessageRecord({ atcID: toSessionID('s1') });

  await ctx.store.writeMessage(record);

  const updated = await ctx.store.updateMessageDelivered(
    record.id,
    { atcID: toSessionID('s2') },
    2000,
  );

  expect(updated).toBeNull();
});

test('it refuses to answer a message owned by another session', async () => {
  const ctx = await setupTest();

  const record = buildMockMessageRecord({ atcID: toSessionID('s1') });

  await ctx.store.writeMessage(record);

  const updated = await ctx.store.updateMessagesAnswered(
    [record.id],
    { atcID: toSessionID('s2') },
    'done',
    2000,
  );

  expect(updated).toStrictEqual([]);
});

test('it gives messages sent before SessionStart their agent session id', async () => {
  const ctx = await setupTest();

  const record = buildMockMessageRecord({ atcID: toSessionID('s1') });

  await ctx.store.writeMessage(record);
  await ctx.store.updateMessageOwner(toSessionID('s1'), undefined, toAgentSessionID('a1'));

  const found = await ctx.store.findMessage(record.id, {
    atcID: toSessionID('s2'),
    agentSessionID: toAgentSessionID('a1'),
  });

  expect(found).toStrictEqual({ ...record, agentSessionID: toAgentSessionID('a1') });
});

test('it moves messages to a changed agent session id', async () => {
  const ctx = await setupTest();

  const record = buildMockMessageRecord({
    atcID: toSessionID('s1'),
    agentSessionID: toAgentSessionID('a1'),
  });

  await ctx.store.writeMessage(record);

  await ctx.store.updateMessageOwner(
    toSessionID('s2'),
    toAgentSessionID('a1'),
    toAgentSessionID('a2'),
  );

  const found = await ctx.store.findMessage(record.id, {
    atcID: toSessionID('s3'),
    agentSessionID: toAgentSessionID('a2'),
  });

  expect(found).toStrictEqual({ ...record, agentSessionID: toAgentSessionID('a2') });
});

test('it keeps messages across a store reopen', async () => {
  const ctx = await setupTest();

  const record = buildMockMessageRecord();

  await ctx.store.writeMessage(record);
  await ctx.store.stop();

  const second = await StateStore.open(ctx.dbPath);

  registerTestCleanup(() => second.stop());

  const pending = await second.collectPendingMessages({ atcID: record.atcID });

  expect(pending).toStrictEqual([record]);
});

test('it finds a message for its own session', async () => {
  const ctx = await setupTest();

  const record = buildMockMessageRecord();

  await ctx.store.writeMessage(record);

  const own = await ctx.store.findMessage(record.id, { atcID: record.atcID });

  expect(own).toStrictEqual(record);
});

test('it finds no message for another session', async () => {
  const ctx = await setupTest();

  const record = buildMockMessageRecord({ atcID: toSessionID('s1') });

  await ctx.store.writeMessage(record);

  const other = await ctx.store.findMessage(record.id, { atcID: toSessionID('s2') });

  expect(other).toBeNull();
});

test('it serves the pending messages of an atc id from an index', async () => {
  const ctx = await setupTest();

  await ctx.store.collectPendingMessages({ atcID: toSessionID('s1') });

  const query = ctx.queries.at(-1);

  invariant(query !== undefined, 'the store ran no query');

  const plan = readQueryPlan(ctx.dbPath, query);

  expect(plan).toInclude('USING INDEX messages_atc_id_status_sent_at');
});

test('it serves the pending messages of an agent session id from an index', async () => {
  const ctx = await setupTest();

  await ctx.store.collectPendingMessages({
    atcID: toSessionID('s1'),
    agentSessionID: toAgentSessionID('a1'),
  });

  const query = ctx.queries.at(-1);

  invariant(query !== undefined, 'the store ran no query');

  const plan = readQueryPlan(ctx.dbPath, query);

  expect(plan).toInclude('USING INDEX messages_agent_session_id_status_sent_at');
});

test('it finds a message by its id alone', async () => {
  const ctx = await setupTest();

  const record = buildMockMessageRecord();

  await ctx.store.writeMessage(record);

  const found = await ctx.store.findMessageByID(record.id);

  expect(found).toStrictEqual(record);
});

test('it finds no message for an unknown id', async () => {
  const ctx = await setupTest();

  await ctx.store.writeMessage(buildMockMessageRecord({ id: toMessageID('m-1') }));

  const missing = await ctx.store.findMessageByID(toMessageID('m-2'));

  expect(missing).toBeNull();
});

test('it records a message status change into the trail with its message id', async () => {
  const ctx = await setupTest();

  await ctx.store.recordTrailEntry({
    at: 1000,
    atcID: toSessionID('s1'),
    agentSessionID: toAgentSessionID('c1'),
    kind: 'message-queued',
    message: toMessageID('m-1'),
    detail: 'hello',
  });

  const events = await ctx.store.collectLatestEvents(10);

  expect(events).toStrictEqual([
    {
      id: expect.toBeNumber(),
      at: 1000,
      atcID: toSessionID('s1'),
      agentSessionID: toAgentSessionID('c1'),
      kind: 'message-queued',
      detail: 'hello',
      message: toMessageID('m-1'),
    },
  ]);
});

test('it records a note into the trail with its label', async () => {
  const ctx = await setupTest();

  await ctx.store.recordTrailEntry({
    at: 1000,
    atcID: toSessionID('s1'),
    agentSessionID: null,
    kind: 'note',
    label: 'blocked',
    detail: 'need review',
    text: 'need review',
  });

  const events = await ctx.store.collectLatestEvents(10);

  expect(events).toStrictEqual([
    {
      id: expect.toBeNumber(),
      at: 1000,
      atcID: toSessionID('s1'),
      agentSessionID: null,
      kind: 'note',
      detail: 'need review',
      label: 'blocked',
    },
  ]);
});

test('it stores a note resent under the same note id once', async () => {
  const ctx = await setupTest();

  const first = await ctx.store.recordTrailEntry({
    at: 1000,
    atcID: toSessionID('s1'),
    agentSessionID: null,
    kind: 'note',
    label: 'blocked',
    detail: 'need review',
    text: 'need review',
    noteID: 'r-1',
  });

  const resent = await ctx.store.recordTrailEntry({
    at: 2000,
    atcID: toSessionID('s1'),
    agentSessionID: null,
    kind: 'note',
    label: 'blocked',
    detail: 'need review',
    text: 'need review',
    noteID: 'r-1',
  });

  const events = await ctx.store.collectLatestEvents(10);

  expect(first).toBeTrue();
  expect(resent).toBeFalse();

  expect(events).toStrictEqual([
    {
      id: expect.toBeNumber(),
      at: 1000,
      atcID: toSessionID('s1'),
      agentSessionID: null,
      kind: 'note',
      detail: 'need review',
      label: 'blocked',
    },
  ]);
});

test('it stores every note that carries no note id', async () => {
  const ctx = await setupTest();

  await ctx.store.recordTrailEntry({
    at: 1000,
    atcID: toSessionID('s1'),
    agentSessionID: null,
    kind: 'note',
    label: 'blocked',
    detail: 'need review',
    text: 'need review',
  });

  const second = await ctx.store.recordTrailEntry({
    at: 2000,
    atcID: toSessionID('s1'),
    agentSessionID: null,
    kind: 'note',
    label: 'blocked',
    detail: 'need review',
    text: 'need review',
  });

  const events = await ctx.store.collectLatestEvents(10);

  expect(second).toBeTrue();

  expect(events).toStrictEqual([
    {
      id: expect.toBeNumber(),
      at: 1000,
      atcID: toSessionID('s1'),
      agentSessionID: null,
      kind: 'note',
      detail: 'need review',
      label: 'blocked',
    },
    {
      id: expect.toBeNumber(),
      at: 2000,
      atcID: toSessionID('s1'),
      agentSessionID: null,
      kind: 'note',
      detail: 'need review',
      label: 'blocked',
    },
  ]);
});

test("it finds a note's whole text by its trail id", async () => {
  const ctx = await setupTest();

  await ctx.store.recordTrailEntry({
    at: 1000,
    atcID: toSessionID('s1'),
    agentSessionID: toAgentSessionID('c1'),
    kind: 'note',
    label: 'decision',
    detail: 'pick one…',
    text: 'pick one of three options',
  });

  const [event] = await ctx.store.collectLatestEvents(1);

  invariant(event !== undefined, 'no event');

  const note = await ctx.store.findNote(event.id);

  expect(note).toStrictEqual({
    id: event.id,
    at: 1000,
    atcID: toSessionID('s1'),
    agentSessionID: toAgentSessionID('c1'),
    label: 'decision',
    text: 'pick one of three options',
    complete: true,
  });
});

test('it misses a trail id whose row is not a note', async () => {
  const ctx = await setupTest();

  await ctx.store.recordEvent(
    { atcId: toSessionID('s1'), event: 'SessionStart', payload: {} },
    { kind: 'started' },
  );

  const [event] = await ctx.store.collectLatestEvents(1);

  invariant(event !== undefined, 'no event');

  const note = await ctx.store.findNote(event.id);

  expect(note).toBeNull();
});

test('it finds a note of a session inside the scope', async () => {
  const ctx = await setupTest();

  await ctx.store.recordTrailEntry({
    at: 1000,
    atcID: toSessionID('s1'),
    agentSessionID: null,
    kind: 'note',
    label: 'decision',
    detail: 'shown',
    text: 'shown',
  });

  const [event] = await ctx.store.collectLatestEvents(1);

  invariant(event);

  const note = await ctx.store.findNote(event.id, {
    atcIDs: [toSessionID('s1')],
    agentSessionIDs: [],
  });

  expect(note).toStrictEqual({
    id: event.id,
    at: 1000,
    atcID: toSessionID('s1'),
    agentSessionID: null,
    label: 'decision',
    text: 'shown',
    complete: true,
  });
});

test('it misses a note of a session outside the scope', async () => {
  const ctx = await setupTest();

  await ctx.store.recordTrailEntry({
    at: 1000,
    atcID: toSessionID('s1'),
    agentSessionID: null,
    kind: 'note',
    label: 'decision',
    detail: 'hidden',
    text: 'hidden',
  });

  const [event] = await ctx.store.collectLatestEvents(1);

  invariant(event !== undefined, 'no event');

  const note = await ctx.store.findNote(event.id, {
    atcIDs: [toSessionID('s2')],
    agentSessionIDs: [],
  });

  expect(note).toBeNull();
});

test('it finds the preview of a note recorded without its whole text', async () => {
  const ctx = await setupTest();

  await ctx.store.recordTrailEntry({
    at: 1000,
    atcID: toSessionID('s1'),
    agentSessionID: null,
    kind: 'note',
    label: 'decision',
    detail: 'the preview',
    text: 'the preview and the rest',
  });

  await ctx.store.stop();

  const db = new Database(ctx.dbPath);

  registerTestCleanup(() => {
    db.close();
  });

  db.run('UPDATE events SET note_text = NULL');
  db.close();

  const store = await StateStore.open(ctx.dbPath);

  registerTestCleanup(() => store.stop());

  const [event] = await store.collectLatestEvents(1);

  invariant(event !== undefined, 'no event');

  const note = await store.findNote(event.id);

  expect(note).toStrictEqual({
    id: event.id,
    at: 1000,
    atcID: toSessionID('s1'),
    agentSessionID: null,
    label: 'decision',
    text: 'the preview',
    complete: false,
  });
});

test('it finds the whole answer of a message-answered entry by its trail id', async () => {
  const ctx = await setupTest();

  await ctx.store.recordTrailEntry({
    at: 1000,
    atcID: toSessionID('s1'),
    agentSessionID: toAgentSessionID('c1'),
    kind: 'message-answered',
    message: toMessageID('m-1'),
    detail: 'the preview',
    text: 'the preview and the rest of the answer',
  });

  const [event] = await ctx.store.collectLatestEvents(1);

  invariant(event !== undefined, 'no event');

  const answer = await ctx.store.findAnswer(event.id);

  expect(answer).toStrictEqual({
    id: event.id,
    at: 1000,
    atcID: toSessionID('s1'),
    agentSessionID: toAgentSessionID('c1'),
    message: toMessageID('m-1'),
    text: 'the preview and the rest of the answer',
    complete: true,
  });
});

test('it finds no answer at the trail id of an entry that is not an answered message', async () => {
  const ctx = await setupTest();

  await ctx.store.recordTrailEntry({
    at: 1000,
    atcID: toSessionID('s1'),
    agentSessionID: null,
    kind: 'message-delivered',
    message: toMessageID('m-1'),
    detail: 'hello',
  });

  const [event] = await ctx.store.collectLatestEvents(1);

  invariant(event !== undefined, 'no event');

  const answer = await ctx.store.findAnswer(event.id);

  expect(answer).toBeNull();
});

test('it adds an empty answer text to the answered rows of a database from before the column', async () => {
  const ctx = await setupTest();

  await ctx.store.stop();

  const older = new Database(ctx.dbPath);

  registerTestCleanup(() => {
    older.close();
  });

  older.run('ALTER TABLE events DROP COLUMN answer_text');

  older.run(
    "INSERT INTO events (ts, atc_id, event, message, kind, detail) VALUES ('1970-01-01T00:00:02.000Z', 's1', 'SessionMessage', 'm-1', 'message-answered', 'the old preview')",
  );

  older.run("DELETE FROM kysely_migration WHERE name = '034_add_events_answer_text'");
  older.close();

  const upgraded = await StateStore.open(ctx.dbPath);

  registerTestCleanup(() => upgraded.stop());

  const reader = new Database(ctx.dbPath, { readonly: true });

  registerTestCleanup(() => {
    reader.close();
  });

  const rows = reader
    .query<{ id: number; answer_text: string | null }, []>('SELECT id, answer_text FROM events')
    .all();

  const [row] = rows;

  invariant(row !== undefined, 'no row');

  const answer = await upgraded.findAnswer(row.id);

  expect(rows).toStrictEqual([{ id: row.id, answer_text: null }]);

  expect(answer).toStrictEqual({
    id: row.id,
    at: 2000,
    atcID: toSessionID('s1'),
    agentSessionID: null,
    message: toMessageID('m-1'),
    text: 'the old preview',
    complete: false,
  });
});

test('it reads the trail in order across hook events and message entries', async () => {
  const ctx = await setupTest();

  await ctx.store.recordEvent(
    { atcId: toSessionID('s1'), event: 'SessionStart', payload: {} },
    { kind: 'started' },
  );

  await ctx.store.recordTrailEntry({
    at: 1000,
    atcID: toSessionID('s1'),
    agentSessionID: null,
    kind: 'message-queued',
    message: toMessageID('m-1'),
    detail: 'hello',
  });

  await ctx.store.recordEvent(
    { atcId: toSessionID('s1'), event: 'Stop', payload: {} },
    { kind: 'turn-done' },
  );

  const events = await ctx.store.collectLatestEvents(10);

  expect(events).toStrictEqual([
    {
      id: expect.toBeNumber(),
      at: expect.toBeNumber(),
      atcID: toSessionID('s1'),
      agentSessionID: null,
      kind: 'started',
      detail: null,
    },
    {
      id: expect.toBeNumber(),
      at: 1000,
      atcID: toSessionID('s1'),
      agentSessionID: null,
      kind: 'message-queued',
      detail: 'hello',
      message: toMessageID('m-1'),
    },
    {
      id: expect.toBeNumber(),
      at: expect.toBeNumber(),
      atcID: toSessionID('s1'),
      agentSessionID: null,
      kind: 'turn-done',
      detail: null,
    },
  ]);
});

test('it stamps trail entries recorded before the agent session id was known', async () => {
  const ctx = await setupTest();

  await ctx.store.recordTrailEntry({
    at: 1000,
    atcID: toSessionID('s1'),
    agentSessionID: null,
    kind: 'message-queued',
    message: toMessageID('m-1'),
    detail: 'hello',
  });

  await ctx.store.recordTrailEntry({
    at: 2000,
    atcID: toSessionID('s2'),
    agentSessionID: null,
    kind: 'note',
    label: 'blocked',
    detail: 'other session',
    text: 'other session',
  });

  await ctx.store.updateTrailOwner(toSessionID('s1'), toAgentSessionID('c1'));

  const events = await ctx.store.collectLatestEvents(10);

  expect(events).toStrictEqual([
    {
      id: expect.toBeNumber(),
      at: 1000,
      atcID: toSessionID('s1'),
      agentSessionID: toAgentSessionID('c1'),
      kind: 'message-queued',
      detail: 'hello',
      message: toMessageID('m-1'),
    },
    {
      id: expect.toBeNumber(),
      at: 2000,
      atcID: toSessionID('s2'),
      agentSessionID: null,
      kind: 'note',
      detail: 'other session',
      label: 'blocked',
    },
  ]);
});

test("it counts a trail entry toward its session's last activity time", async () => {
  const ctx = await setupTest();

  await ctx.store.recordTrailEntry({
    at: 5000,
    atcID: toSessionID('s-old'),
    agentSessionID: toAgentSessionID('c1'),
    kind: 'note',
    label: 'blocked',
    detail: 'need review',
    text: 'need review',
  });

  const at = await ctx.store.loadLastActivityAt(toSessionID('s-new'), toAgentSessionID('c1'));

  expect(at).toBe(5000);
});

test('it answers every message of one turn in one call and returns them oldest first', async () => {
  const ctx = await setupTest();

  const two = buildMockMessageRecord({ atcID: toSessionID('s1'), sentAt: 2000 });
  const one = buildMockMessageRecord({ atcID: toSessionID('s1'), sentAt: 1000 });

  await ctx.store.writeMessage(two);
  await ctx.store.writeMessage(one);

  const answered = await ctx.store.updateMessagesAnswered(
    [two.id, one.id],
    { atcID: toSessionID('s1') },
    'both',
    3000,
    't-1',
  );

  expect(answered).toStrictEqual([
    { ...one, status: 'answered', answeredAt: 3000, answer: 'both', turn: 't-1' },
    { ...two, status: 'answered', answeredAt: 3000, answer: 'both', turn: 't-1' },
  ]);
});

test('it lists the other messages answered in the same turn as siblings', async () => {
  const ctx = await setupTest();

  const two = buildMockMessageRecord({ atcID: toSessionID('s1'), sentAt: 2000 });
  const one = buildMockMessageRecord({ atcID: toSessionID('s1'), sentAt: 1000 });

  await ctx.store.writeMessage(two);
  await ctx.store.writeMessage(one);

  await ctx.store.updateMessagesAnswered(
    [two.id, one.id],
    { atcID: toSessionID('s1') },
    'both',
    3000,
    't-1',
  );

  const oldest = await ctx.store.findMessage(one.id, { atcID: toSessionID('s1') });

  invariant(oldest !== null, 'oldest message missing');

  const siblings = await ctx.store.collectTurnSiblings(oldest);

  expect(siblings).toStrictEqual([{ id: two.id, atcID: toSessionID('s1') }]);
});

test('it lists no siblings for a message its turn left unanswered beside another', async () => {
  const ctx = await setupTest();

  const one = buildMockMessageRecord({ atcID: toSessionID('s1'), sentAt: 1000 });
  const two = buildMockMessageRecord({ atcID: toSessionID('s1'), sentAt: 2000 });

  await ctx.store.writeMessage(one);
  await ctx.store.writeMessage(two);

  await ctx.store.updateMessagesUnanswered(
    [one.id, two.id],
    { atcID: toSessionID('s1') },
    'error',
    3000,
    't-1',
  );

  const unanswered = await ctx.store.findMessage(one.id, { atcID: toSessionID('s1') });

  invariant(unanswered !== null, 'unanswered message missing');

  const siblings = await ctx.store.collectTurnSiblings(unanswered);

  expect(siblings).toStrictEqual([]);
});

test('it keeps the turn of a message its turn left unanswered', async () => {
  const ctx = await setupTest();

  const one = buildMockMessageRecord({ atcID: toSessionID('s1'), sentAt: 1000 });

  await ctx.store.writeMessage(one);

  await ctx.store.updateMessagesUnanswered(
    [one.id],
    { atcID: toSessionID('s1') },
    'error',
    3000,
    't-1',
  );

  const unanswered = await ctx.store.findMessage(one.id, { atcID: toSessionID('s1') });

  expect(unanswered?.turn).toBe('t-1');
});

test('it leaves an unanswered message of the same turn out of the siblings of an answered one', async () => {
  const ctx = await setupTest();

  const answeredOne = buildMockMessageRecord({ atcID: toSessionID('s1'), sentAt: 1000 });
  const unansweredOne = buildMockMessageRecord({ atcID: toSessionID('s1'), sentAt: 2000 });

  await ctx.store.writeMessage(answeredOne);
  await ctx.store.writeMessage(unansweredOne);

  await ctx.store.updateMessagesAnswered(
    [answeredOne.id],
    { atcID: toSessionID('s1') },
    'done',
    3000,
    't-1',
  );

  await ctx.store.updateMessagesUnanswered(
    [unansweredOne.id],
    { atcID: toSessionID('s1') },
    'error',
    3000,
    't-1',
  );

  const answered = await ctx.store.findMessage(answeredOne.id, { atcID: toSessionID('s1') });

  invariant(answered !== null, 'answered message missing');

  const siblings = await ctx.store.collectTurnSiblings(answered);

  expect(siblings).toStrictEqual([]);
});

test('it lists the other messages of one turn in send order when they share a send time', async () => {
  const ctx = await setupTest();

  const first = buildMockMessageRecord({
    id: toMessageID('m-c'),
    atcID: toSessionID('s1'),
    sentAt: 1000,
  });

  const second = buildMockMessageRecord({
    id: toMessageID('m-b'),
    atcID: toSessionID('s1'),
    sentAt: 1000,
  });

  const third = buildMockMessageRecord({
    id: toMessageID('m-a'),
    atcID: toSessionID('s1'),
    sentAt: 1000,
  });

  await ctx.store.writeMessage(first);
  await ctx.store.writeMessage(second);
  await ctx.store.writeMessage(third);

  await ctx.store.updateMessagesAnswered(
    [first.id, second.id, third.id],
    { atcID: toSessionID('s1') },
    'all',
    2000,
    't-1',
  );

  const answered = await ctx.store.findMessage(first.id, { atcID: toSessionID('s1') });

  invariant(answered !== null, 'first message missing');

  const siblings = await ctx.store.collectTurnSiblings(answered);

  expect(siblings).toStrictEqual([
    { id: toMessageID('m-b'), atcID: toSessionID('s1') },
    { id: toMessageID('m-a'), atcID: toSessionID('s1') },
  ]);
});

test('it links a legacy fleet.json sub-session to its parent by the minted session id', async () => {
  const tmp = setupTempDir('atc-store-');
  const legacy = join(tmp.dir, 'fleet.json');

  writeFileSync(
    legacy,
    JSON.stringify([
      { name: 'wrangler', cwd: '/z', agentSessionID: 'c-parent' },
      { name: 'worker', cwd: '/z', agentSessionID: 'c-child', parent: 'c-parent' },
    ]),
  );

  const store = await StateStore.open(join(tmp.dir, 'state.db'), legacy);

  registerTestCleanup(() => store.stop());

  const fleet = await store.loadFleet();

  const parent = fleet.find((entry) => entry.name === 'wrangler');
  const child = fleet.find((entry) => entry.name === 'worker');

  invariant(parent !== undefined && child !== undefined, 'expected both seeded entries');

  expect(fleet).toStrictEqual([
    {
      sessionID: expect.toSatisfy((id: string) =>
        /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/.test(id),
      ),
      name: 'wrangler',
      cwd: '/z',
      agentSessionID: toAgentSessionID('c-parent'),
      agent: 'claude',
    },
    {
      sessionID: expect.toSatisfy((id: string) =>
        /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/.test(id),
      ),
      name: 'worker',
      cwd: '/z',
      agentSessionID: toAgentSessionID('c-child'),
      agent: 'claude',
      parent: parent.sessionID,
    },
  ]);
});

test('it rebuilds a fleet at the model-and-effort shape keyed by a minted session id', async () => {
  const tmp = setupTempDir('atc-store-');
  const dbPath = join(tmp.dir, 'state.db');

  const db = new Database(dbPath);

  registerTestCleanup(() => {
    db.close();
  });

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

  registerTestCleanup(() => store.stop());

  const fleet = await store.loadFleet();

  const reader = new Database(dbPath, { readonly: true });

  registerTestCleanup(() => {
    reader.close();
  });

  const ledger = reader
    .query<{ name: string }, []>('SELECT name FROM kysely_migration')
    .all()
    .map((row) => row.name);

  const parent = fleet.find((entry) => entry.name === 'wrangler');

  invariant(parent !== undefined, 'expected the parent row');

  expect(fleet).toStrictEqual([
    {
      sessionID: expect.toSatisfy((id: string) =>
        /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/.test(id),
      ),
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
      sessionID: expect.toSatisfy((id: string) =>
        /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/.test(id),
      ),
      name: 'worker',
      cwd: '/x',
      agentSessionID: toAgentSessionID('c-child'),
      agent: 'claude',
      exited: true,
      parent: parent.sessionID,
    },
    {
      sessionID: expect.toSatisfy((id: string) =>
        /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/.test(id),
      ),
      name: 'stray',
      cwd: '/x',
      agentSessionID: toAgentSessionID('c-orphan'),
      agent: 'grok',
    },
    {
      sessionID: expect.toSatisfy((id: string) =>
        /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/.test(id),
      ),
      name: 'unreported',
      cwd: '/x',
      agent: 'claude',
      exited: true,
    },
  ]);

  expect(new Set(fleet.map((entry) => entry.sessionID)).size).toBe(4);
  expect(ledger).toContain('015_rebuild_fleet_keyed_by_session_id');
});

test('it keeps a fleet row that has no agent session id', async () => {
  const ctx = await setupTest();

  // The factory always sets an agent session id, so this row is written out.
  await ctx.store.writeFleet([
    { sessionID: toSessionID('s-new'), name: 'booting', cwd: '/x', agent: 'claude' },
  ]);

  const fleet = await ctx.store.loadFleet();

  expect(fleet).toStrictEqual([
    { sessionID: toSessionID('s-new'), name: 'booting', cwd: '/x', agent: 'claude' },
  ]);
});

test('it keeps the later of two fleet entries that share an agent session id', async () => {
  const ctx = await setupTest();

  const first = buildMockFleetEntry({ agentSessionID: toAgentSessionID('c-first') });
  const resumed = buildMockFleetEntry({ agentSessionID: toAgentSessionID('c-first') });

  await ctx.store.writeFleet([first, resumed]);

  const fleet = await ctx.store.loadFleet();

  expect(fleet).toStrictEqual([resumed]);
});

test('it mints a random uuid as the daemon id', async () => {
  const ctx = await setupTest();

  expect(ctx.store.daemonID).toMatch(
    /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/,
  );
});

test('it keeps the same daemon id across a reopen', async () => {
  const ctx = await setupTest();

  const firstID = ctx.store.daemonID;

  await ctx.store.stop();

  const second = await StateStore.open(ctx.dbPath);

  registerTestCleanup(() => second.stop());

  expect(second.daemonID).toBe(firstID);
});

test('it records this daemon as the owner of every fleet row it migrates', async () => {
  const tmp = setupTempDir('atc-store-');
  const dbPath = join(tmp.dir, 'state.db');

  const db = new Database(dbPath);

  registerTestCleanup(() => {
    db.close();
  });

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

  registerTestCleanup(() => store.stop());

  const daemonID = store.daemonID;

  const fleet = await store.loadFleet();

  await store.stop();

  const reader = new Database(dbPath, { readonly: true });

  registerTestCleanup(() => {
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
  const ctx = await setupTest();

  const other = new Database(ctx.dbPath);

  registerTestCleanup(() => {
    other.close();
  });

  other.run(
    "INSERT INTO fleet (session_id, agent_session_id, name, cwd) VALUES ('s-theirs', 'c-theirs', 'theirs', '/z')",
  );

  other.run(
    "INSERT INTO session_owner (session_id, daemon_id, updated_at) VALUES ('s-theirs', 'd-other', 1)",
  );

  other.close();

  const mine = buildMockFleetEntry({ sessionID: toSessionID('s-mine') });
  const next = buildMockFleetEntry({ sessionID: toSessionID('s-next') });

  await ctx.store.writeFleet([mine]);
  await ctx.store.writeFleet([next], [mine.sessionID]);

  const reader = new Database(ctx.dbPath, { readonly: true });

  registerTestCleanup(() => {
    reader.close();
  });

  const stored = reader
    .query<{ session_id: string }, []>('SELECT session_id FROM fleet ORDER BY session_id')
    .all()
    .map((row) => row.session_id);

  const fleet = await ctx.store.loadFleet();

  expect(stored).toStrictEqual(['s-next', 's-theirs']);
  expect(fleet).toStrictEqual([next]);
});

test('it rejects a fleet write for a session whose ownership epoch moved on as stale', async () => {
  const ctx = await setupTest();

  const before = buildMockFleetEntry({ sessionID: toSessionID('s-1') });

  await ctx.store.writeFleet([before]);

  const other = new Database(ctx.dbPath);

  registerTestCleanup(() => {
    other.close();
  });

  other.run("UPDATE session_owner SET owner_epoch = 2 WHERE session_id = 's-1'");
  other.close();

  const write = ctx.store.writeFleet([buildMockFleetEntry({ sessionID: toSessionID('s-1') })]);

  await Promise.allSettled([write]);

  const fleet = await ctx.store.loadFleet();

  expect(write).rejects.toMatchObject({
    name: 'StaleOwnershipError',
    sessionID: 's-1',
    ownerEpoch: 2,
  });

  expect(fleet).toStrictEqual([before]);
});

test('it rejects a fleet write for a session another daemon owns as stale', async () => {
  const ctx = await setupTest();

  const other = new Database(ctx.dbPath);

  registerTestCleanup(() => {
    other.close();
  });

  other.run(
    "INSERT INTO session_owner (session_id, daemon_id, updated_at) VALUES ('s-theirs', 'd-other', 1)",
  );

  other.close();

  const write = ctx.store.writeFleet([buildMockFleetEntry({ sessionID: toSessionID('s-theirs') })]);

  expect(write).rejects.toMatchObject({
    name: 'StaleOwnershipError',
    sessionID: 's-theirs',
    ownerDaemonID: 'd-other',
    ownerEpoch: 1,
  });
});

test('it rejects a fleet row update for a session whose ownership epoch moved on as stale', async () => {
  const ctx = await setupTest();

  await ctx.store.writeFleet([buildMockFleetEntry({ sessionID: toSessionID('s-1') })]);

  const other = new Database(ctx.dbPath);

  registerTestCleanup(() => {
    other.close();
  });

  other.run("UPDATE session_owner SET owner_epoch = 2 WHERE session_id = 's-1'");
  other.close();

  expect(ctx.store.updateFleetEntry(toSessionID('s-1'), { result: 'late' })).rejects.toMatchObject({
    name: 'StaleOwnershipError',
    sessionID: 's-1',
    ownerEpoch: 2,
  });
});

test('it claims a free idempotency key', async () => {
  const ctx = await setupTest();

  const claim = {
    principal: 'local',
    operation: 'session.spawn',
    key: 'k-1',
    payloadHash: 'h-1',
    effectRef: 's-1',
    at: 1000,
  };

  const claimed = await ctx.store.claimIdempotencyKey(claim);

  expect(claimed).toBeNull();
});

test('it hands back the record of a held idempotency key', async () => {
  const ctx = await setupTest();

  const claim = {
    principal: 'local',
    operation: 'session.spawn',
    key: 'k-1',
    payloadHash: 'h-1',
    effectRef: 's-1',
    at: 1000,
  };

  await ctx.store.claimIdempotencyKey(claim);

  const held = await ctx.store.claimIdempotencyKey({ ...claim, effectRef: 's-2', at: 2000 });

  expect(held).toStrictEqual({
    principal: 'local',
    operation: 'session.spawn',
    key: 'k-1',
    payloadHash: 'h-1',
    state: 'in_progress',
    effectRef: 's-1',
    result: null,
    effectTarget: null,
    createdAt: 1000,
    updatedAt: 1000,
  });
});

test("it keeps the target a completed key's effect was bound to", async () => {
  const ctx = await setupTest();

  const claim = {
    principal: 'local',
    operation: 'session.spawn',
    key: 'k-1',
    payloadHash: 'h-1',
    effectRef: 's-1',
    at: 1000,
  };

  await ctx.store.claimIdempotencyKey(claim);

  await ctx.store.updateIdempotencyCompleted(claim, '{}', 2000, {
    target: 'box',
    targetIdentity: 'local-pty:0123456789abcdef',
  });

  const held = await ctx.store.claimIdempotencyKey(claim);

  expect(held).toStrictEqual({
    principal: 'local',
    operation: 'session.spawn',
    key: 'k-1',
    payloadHash: 'h-1',
    state: 'completed',
    effectRef: 's-1',
    result: '{}',
    effectTarget: { target: 'box', targetIdentity: 'local-pty:0123456789abcdef' },
    createdAt: 1000,
    updatedAt: 2000,
  });
});

test('it reconciles an interrupted spawn key by whether its session reached the fleet', async () => {
  const ctx = await setupTest();

  const claim = { principal: 'local', operation: 'session.spawn', payloadHash: 'h', at: 1000 };

  await ctx.store.claimIdempotencyKey({ ...claim, key: 'landed', effectRef: 's-landed' });
  await ctx.store.claimIdempotencyKey({ ...claim, key: 'lost', effectRef: 's-lost' });
  await ctx.store.writeFleet([buildMockFleetEntry({ sessionID: toSessionID('s-landed') })]);

  const landedBefore = await ctx.store.findIdempotencyKey({ ...claim, key: 'landed' });
  const lostBefore = await ctx.store.findIdempotencyKey({ ...claim, key: 'lost' });

  await ctx.store.reconcileIdempotencyKeys(5000);

  const landed = await ctx.store.claimIdempotencyKey({ ...claim, key: 'landed', effectRef: 'x' });
  const lost = await ctx.store.claimIdempotencyKey({ ...claim, key: 'lost', effectRef: 'x' });

  expect(landedBefore?.state).toBe('in_progress');
  expect(lostBefore?.state).toBe('in_progress');

  expect(landed).toStrictEqual({
    principal: 'local',
    operation: 'session.spawn',
    key: 'landed',
    payloadHash: 'h',
    state: 'completed',
    effectRef: 's-landed',
    result: null,
    effectTarget: null,
    createdAt: 1000,
    updatedAt: 5000,
  });

  expect(lost).toStrictEqual({
    principal: 'local',
    operation: 'session.spawn',
    key: 'lost',
    payloadHash: 'h',
    state: 'outcome_unknown',
    effectRef: 's-lost',
    result: null,
    effectTarget: null,
    createdAt: 1000,
    updatedAt: 5000,
  });
});

test('it expires completed idempotency keys and keeps unknown outcomes of the same age', async () => {
  const ctx = await setupTest();

  const claim = { principal: 'local', operation: 'session.spawn', payloadHash: 'h', at: 1000 };

  await ctx.store.claimIdempotencyKey({ ...claim, key: 'done', effectRef: 's-done' });

  await ctx.store.updateIdempotencyCompleted(
    { principal: 'local', operation: 'session.spawn', key: 'done' },
    '{}',
    1000,
  );

  await ctx.store.claimIdempotencyKey({ ...claim, key: 'unknown', effectRef: 's-unknown' });
  await ctx.store.reconcileIdempotencyKeys(1000);
  await ctx.store.removeExpiredIdempotencyKeys(2000);

  const done = await ctx.store.claimIdempotencyKey({ ...claim, key: 'done', effectRef: 's-new' });
  const unknown = await ctx.store.claimIdempotencyKey({ ...claim, key: 'unknown', effectRef: 'x' });

  expect(done).toBeNull();

  expect(unknown).toStrictEqual({
    principal: 'local',
    operation: 'session.spawn',
    key: 'unknown',
    payloadHash: 'h',
    state: 'outcome_unknown',
    effectRef: 's-unknown',
    result: null,
    effectTarget: null,
    createdAt: 1000,
    updatedAt: 1000,
  });
});

test('it writes no row as its own parent when every row in a chain shares one agent session id', async () => {
  const ctx = await setupTest();

  const top = buildMockFleetEntry({ agentSessionID: toAgentSessionID('c-top') });

  const sub = buildMockFleetEntry({
    agentSessionID: toAgentSessionID('c-top'),
    parent: top.sessionID,
  });

  const resumed = buildMockFleetEntry({ agentSessionID: toAgentSessionID('c-top') });

  await ctx.store.writeFleet([top, sub, { ...resumed, parent: sub.sessionID }]);

  const fleet = await ctx.store.loadFleet();

  expect(fleet).toStrictEqual([resumed]);
});

test('it moves the sub-sessions of a replaced row up to the parent of the sub-session that replaced it', async () => {
  const ctx = await setupTest();

  const other = buildMockFleetEntry();
  const first = buildMockFleetEntry({ agentSessionID: toAgentSessionID('c-first') });
  const worker = buildMockFleetEntry({ parent: first.sessionID });

  const resumed = buildMockFleetEntry({
    agentSessionID: toAgentSessionID('c-first'),
    parent: other.sessionID,
  });

  await ctx.store.writeFleet([other, first, worker, resumed]);

  const fleet = await ctx.store.loadFleet();

  expect(fleet).toStrictEqual([other, { ...worker, parent: other.sessionID }, resumed]);
});

test('it breaks the cycle two crossed resumes make by keeping the earlier row top-level', async () => {
  const ctx = await setupTest();

  // R resumes P's agent session under Q, and S resumes Q's under P: replacing
  // P with R and Q with S links R under S and S under R.
  const p = buildMockFleetEntry({ agentSessionID: toAgentSessionID('c-p') });
  const q = buildMockFleetEntry({ agentSessionID: toAgentSessionID('c-q') });
  const r = buildMockFleetEntry({ agentSessionID: toAgentSessionID('c-p') });
  const s = buildMockFleetEntry({ agentSessionID: toAgentSessionID('c-q'), parent: p.sessionID });

  await ctx.store.writeFleet([p, q, { ...r, parent: q.sessionID }, s]);

  const fleet = await ctx.store.loadFleet();

  expect(fleet).toStrictEqual([r, { ...s, parent: r.sessionID }]);
});

test('it moves a worker under a row that a resume of its own parent replaced', async () => {
  const ctx = await setupTest();

  const p = buildMockFleetEntry({ agentSessionID: toAgentSessionID('c-p') });
  const w = buildMockFleetEntry({ parent: p.sessionID });
  const r = buildMockFleetEntry({ agentSessionID: toAgentSessionID('c-p') });

  await ctx.store.writeFleet([p, w, { ...r, parent: p.sessionID }]);

  const fleet = await ctx.store.loadFleet();

  expect(fleet).toStrictEqual([{ ...w, parent: r.sessionID }, r]);
});

test('it writes three resumes crossed in a ring as one top-level row with every other row under it', async () => {
  const ctx = await setupTest();

  // R resumes P under Q, S resumes Q under T, and U resumes T under P, and
  // each replaced row has a worker of its own.
  const p = buildMockFleetEntry({ agentSessionID: toAgentSessionID('c-p') });
  const q = buildMockFleetEntry({ agentSessionID: toAgentSessionID('c-q') });
  const t = buildMockFleetEntry({ agentSessionID: toAgentSessionID('c-t') });
  const wp = buildMockFleetEntry({ parent: p.sessionID });
  const wq = buildMockFleetEntry({ parent: q.sessionID });
  const r = buildMockFleetEntry({ agentSessionID: toAgentSessionID('c-p') });
  const s = buildMockFleetEntry({ agentSessionID: toAgentSessionID('c-q') });
  const u = buildMockFleetEntry({ agentSessionID: toAgentSessionID('c-t') });

  await ctx.store.writeFleet([
    p,
    q,
    t,
    wp,
    wq,
    { ...r, parent: q.sessionID },
    { ...s, parent: t.sessionID },
    { ...u, parent: p.sessionID },
  ]);

  const fleet = await ctx.store.loadFleet();

  expect(fleet).toStrictEqual([
    { ...wp, parent: r.sessionID },
    { ...wq, parent: r.sessionID },
    r,
    { ...s, parent: r.sessionID },
    { ...u, parent: r.sessionID },
  ]);
});

test("it moves a worker of a replaced row under the parent of the sub-session that took the row's place", async () => {
  const ctx = await setupTest();

  const o = buildMockFleetEntry();
  const f = buildMockFleetEntry({ agentSessionID: toAgentSessionID('c-f') });
  const w = buildMockFleetEntry({ parent: f.sessionID });
  const r = buildMockFleetEntry({ agentSessionID: toAgentSessionID('c-f'), parent: o.sessionID });

  await ctx.store.writeFleet([o, f, w, r]);

  const fleet = await ctx.store.loadFleet();

  expect(fleet).toStrictEqual([o, { ...w, parent: o.sessionID }, r]);
});

test('it writes a row whose parent the write does not hold as a top-level row', async () => {
  const ctx = await setupTest();

  const orphan = buildMockFleetEntry();

  await ctx.store.writeFleet([{ ...orphan, parent: toSessionID('s-gone') }]);

  const fleet = await ctx.store.loadFleet();

  expect(fleet).toStrictEqual([orphan]);
});

test("it moves a row that replaced its own parent under that parent's parent", async () => {
  const ctx = await setupTest();

  const top = buildMockFleetEntry();

  const sub = buildMockFleetEntry({
    agentSessionID: toAgentSessionID('c-sub'),
    parent: top.sessionID,
  });

  const resumed = buildMockFleetEntry({ agentSessionID: toAgentSessionID('c-sub') });

  await ctx.store.writeFleet([top, sub, { ...resumed, parent: sub.sessionID }]);

  const fleet = await ctx.store.loadFleet();

  expect(fleet).toStrictEqual([top, { ...resumed, parent: top.sessionID }]);
});

test('it records a workspace materialization through its phases', async () => {
  const ctx = await setupTest();

  await ctx.store.createMaterialization(
    {
      sessionID: toSessionID('s-ws'),
      target: 'box',
      dir: '/w/s-ws',
      sourceKind: 'git',
      withheldEnv: ['APP_GIT_TOKEN'],
    },
    1000,
  );

  await ctx.store.updateMaterialization(
    toSessionID('s-ws'),
    { phase: 'cloning', repoURL: 'https://example.com/r.git', sha: 'a'.repeat(40), ref: 'main' },
    2000,
  );

  await ctx.store.updateMaterialization(
    toSessionID('s-ws'),
    { phase: 'ready', materializedAt: 3000 },
    3000,
  );

  const row = await ctx.store.findMaterialization(toSessionID('s-ws'));

  expect(row).toStrictEqual({
    sessionID: toSessionID('s-ws'),
    target: 'box',
    dir: '/w/s-ws',
    sourceKind: 'git',
    phase: 'ready',
    repoURL: 'https://example.com/r.git',
    sha: 'a'.repeat(40),
    ref: 'main',
    errorCode: null,
    startedAt: 1000,
    updatedAt: 3000,
    materializedAt: 3000,
    withheldEnv: ['APP_GIT_TOKEN'],
  });
});

test('it fails every materialization a stopped daemon left short of ready', async () => {
  const ctx = await setupTest();

  await ctx.store.createMaterialization(
    {
      sessionID: toSessionID('s-resolving'),
      target: 'box',
      dir: '/w/s-resolving',
      sourceKind: 'path',
      withheldEnv: [],
    },
    1000,
  );

  await ctx.store.createMaterialization(
    {
      sessionID: toSessionID('s-cloning'),
      target: 'box',
      dir: '/w/s-cloning',
      sourceKind: 'path',
      withheldEnv: [],
    },
    1000,
  );

  await ctx.store.createMaterialization(
    {
      sessionID: toSessionID('s-transferring'),
      target: 'box',
      dir: '/w/s-transferring',
      sourceKind: 'path',
      withheldEnv: [],
    },
    1000,
  );

  await ctx.store.createMaterialization(
    {
      sessionID: toSessionID('s-verifying'),
      target: 'box',
      dir: '/w/s-verifying',
      sourceKind: 'path',
      withheldEnv: [],
    },
    1000,
  );

  await ctx.store.createMaterialization(
    {
      sessionID: toSessionID('s-ready'),
      target: 'box',
      dir: '/w/s-ready',
      sourceKind: 'path',
      withheldEnv: [],
    },
    1000,
  );

  await ctx.store.createMaterialization(
    {
      sessionID: toSessionID('s-failed'),
      target: 'box',
      dir: '/w/s-failed',
      sourceKind: 'path',
      withheldEnv: [],
    },
    1000,
  );

  await ctx.store.updateMaterialization(toSessionID('s-cloning'), { phase: 'cloning' }, 1000);

  await ctx.store.updateMaterialization(
    toSessionID('s-transferring'),
    { phase: 'transferring' },
    1000,
  );

  await ctx.store.updateMaterialization(toSessionID('s-verifying'), { phase: 'verifying' }, 1000);
  await ctx.store.updateMaterialization(toSessionID('s-ready'), { phase: 'ready' }, 1000);

  await ctx.store.updateMaterialization(
    toSessionID('s-failed'),
    { phase: 'failed', errorCode: 'clone_failed' },
    1000,
  );

  const resolvingBefore = await ctx.store.findMaterialization(toSessionID('s-resolving'));
  const cloningBefore = await ctx.store.findMaterialization(toSessionID('s-cloning'));
  const transferringBefore = await ctx.store.findMaterialization(toSessionID('s-transferring'));
  const verifyingBefore = await ctx.store.findMaterialization(toSessionID('s-verifying'));

  await ctx.store.stop();

  const second = await StateStore.open(ctx.dbPath);

  registerTestCleanup(() => second.stop());

  await second.reconcileMaterializations(5000);

  const resolving = await second.findMaterialization(toSessionID('s-resolving'));
  const cloning = await second.findMaterialization(toSessionID('s-cloning'));
  const transferring = await second.findMaterialization(toSessionID('s-transferring'));
  const verifying = await second.findMaterialization(toSessionID('s-verifying'));
  const ready = await second.findMaterialization(toSessionID('s-ready'));
  const failed = await second.findMaterialization(toSessionID('s-failed'));

  expect(resolvingBefore?.phase).toBe('resolving');
  expect(cloningBefore?.phase).toBe('cloning');
  expect(transferringBefore?.phase).toBe('transferring');
  expect(verifyingBefore?.phase).toBe('verifying');

  expect(resolving).toStrictEqual({
    sessionID: toSessionID('s-resolving'),
    target: 'box',
    dir: '/w/s-resolving',
    sourceKind: 'path',
    phase: 'failed',
    repoURL: null,
    sha: null,
    ref: null,
    errorCode: 'workspace_interrupted',
    startedAt: 1000,
    updatedAt: 5000,
    materializedAt: null,
    withheldEnv: [],
  });

  expect(cloning).toStrictEqual({
    sessionID: toSessionID('s-cloning'),
    target: 'box',
    dir: '/w/s-cloning',
    sourceKind: 'path',
    phase: 'failed',
    repoURL: null,
    sha: null,
    ref: null,
    errorCode: 'workspace_interrupted',
    startedAt: 1000,
    updatedAt: 5000,
    materializedAt: null,
    withheldEnv: [],
  });

  expect(transferring).toStrictEqual({
    sessionID: toSessionID('s-transferring'),
    target: 'box',
    dir: '/w/s-transferring',
    sourceKind: 'path',
    phase: 'failed',
    repoURL: null,
    sha: null,
    ref: null,
    errorCode: 'workspace_interrupted',
    startedAt: 1000,
    updatedAt: 5000,
    materializedAt: null,
    withheldEnv: [],
  });

  expect(verifying).toStrictEqual({
    sessionID: toSessionID('s-verifying'),
    target: 'box',
    dir: '/w/s-verifying',
    sourceKind: 'path',
    phase: 'failed',
    repoURL: null,
    sha: null,
    ref: null,
    errorCode: 'workspace_interrupted',
    startedAt: 1000,
    updatedAt: 5000,
    materializedAt: null,
    withheldEnv: [],
  });

  expect(ready).toStrictEqual({
    sessionID: toSessionID('s-ready'),
    target: 'box',
    dir: '/w/s-ready',
    sourceKind: 'path',
    phase: 'ready',
    repoURL: null,
    sha: null,
    ref: null,
    errorCode: null,
    startedAt: 1000,
    updatedAt: 1000,
    materializedAt: null,
    withheldEnv: [],
  });

  expect(failed).toStrictEqual({
    sessionID: toSessionID('s-failed'),
    target: 'box',
    dir: '/w/s-failed',
    sourceKind: 'path',
    phase: 'failed',
    repoURL: null,
    sha: null,
    ref: null,
    errorCode: 'clone_failed',
    startedAt: 1000,
    updatedAt: 1000,
    materializedAt: null,
    withheldEnv: [],
  });
});

test('it loads a fleet row with its ready workspace and withheld variables, and none short of ready', async () => {
  const ctx = await setupTest();

  await ctx.store.createMaterialization(
    {
      sessionID: toSessionID('s-ready'),
      target: 'local',
      dir: '/w/s-ready',
      sourceKind: 'git',
      withheldEnv: ['APP_GIT_TOKEN', 'GIT_ASKPASS'],
    },
    1000,
  );

  await ctx.store.createMaterialization(
    {
      sessionID: toSessionID('s-verifying'),
      target: 'local',
      dir: '/w/s-verifying',
      sourceKind: 'git',
      withheldEnv: ['APP_GIT_TOKEN'],
    },
    1000,
  );

  await ctx.store.updateMaterialization(
    toSessionID('s-ready'),
    {
      phase: 'ready',
      repoURL: 'https://example.com/r.git',
      sha: 'b'.repeat(40),
      ref: null,
      materializedAt: 2000,
    },
    2000,
  );

  await ctx.store.updateMaterialization(
    toSessionID('s-verifying'),
    { phase: 'verifying', repoURL: 'https://example.com/r.git', sha: 'b'.repeat(40), ref: null },
    2000,
  );

  const ready = buildMockFleetEntry({ sessionID: toSessionID('s-ready') });
  const verifying = buildMockFleetEntry({ sessionID: toSessionID('s-verifying') });
  const plain = buildMockFleetEntry();

  await ctx.store.writeFleet([ready, verifying, plain]);

  const fleet = await ctx.store.loadFleet();

  expect(fleet).toStrictEqual([
    {
      ...ready,
      workspace: {
        repoURL: 'https://example.com/r.git',
        sha: 'b'.repeat(40),
        materializedAt: 2000,
      },
      withheldEnv: ['APP_GIT_TOKEN', 'GIT_ASKPASS'],
    },
    verifying,
    plain,
  ]);
});

test('it leaves out of the fleet a session whose withheld variables are malformed and keeps its row on the next write', async () => {
  const ctx = await setupTest();

  await ctx.store.createMaterialization(
    {
      sessionID: toSessionID('s-ready'),
      target: 'local',
      dir: '/w/s-ready',
      sourceKind: 'git',
      withheldEnv: ['APP_GIT_TOKEN'],
    },
    1000,
  );

  await ctx.store.updateMaterialization(
    toSessionID('s-ready'),
    {
      phase: 'ready',
      repoURL: 'https://example.com/r.git',
      sha: 'b'.repeat(40),
      ref: null,
      materializedAt: 2000,
    },
    2000,
  );

  const ready = buildMockFleetEntry({ sessionID: toSessionID('s-ready') });
  const plain = buildMockFleetEntry({ sessionID: toSessionID('s-plain') });

  await ctx.store.writeFleet([ready, plain]);

  const writer = new Database(ctx.dbPath);

  registerTestCleanup(() => {
    writer.close();
  });

  writer.run('UPDATE workspace_materialization SET withheld_env = \'["APP_GIT_TOKEN"\'');

  const fleet = await ctx.store.loadFleet();

  await ctx.store.writeFleet(fleet);

  const stored = writer.query('SELECT session_id FROM fleet ORDER BY rowid').all();

  expect(fleet).toStrictEqual([plain]);
  expect(stored).toStrictEqual([{ session_id: 's-ready' }, { session_id: 's-plain' }]);
});

test('it refuses to read a workspace whose withheld variables are malformed', async () => {
  const ctx = await setupTest();

  await ctx.store.createMaterialization(
    {
      sessionID: toSessionID('s-ready'),
      target: 'local',
      dir: '/w/s-ready',
      sourceKind: 'git',
      withheldEnv: ['APP_GIT_TOKEN'],
    },
    1000,
  );

  const writer = new Database(ctx.dbPath);

  registerTestCleanup(() => {
    writer.close();
  });

  writer.run('UPDATE workspace_materialization SET withheld_env = \'{"APP_GIT_TOKEN":true}\'');

  expect(ctx.store.findMaterialization(toSessionID('s-ready'))).rejects.toThrowWithMessage(
    Error,
    "the workspace of session 's-ready' holds a malformed list of withheld variables",
  );
});

test('it upgrades a database from before runtime auth and keeps every existing row', async () => {
  const ctx = await setupTest();

  const entry = buildMockFleetEntry({
    sessionID: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:0123456789abcdef',
  });

  await ctx.store.writeFleet([entry]);

  await ctx.store.recordSpawnDir(
    '/x',
    { target: 'box', targetIdentity: 'imp:0123456789abcdef' },
    1000,
  );

  await ctx.store.stop();

  const older = new Database(ctx.dbPath);

  registerTestCleanup(() => {
    older.close();
  });

  older.run('DROP TABLE runtime_auth_grant');
  older.run('DROP TABLE runtime_auth_binding');
  older.run("DELETE FROM kysely_migration WHERE name = '025_create_runtime_auth'");
  older.close();

  const upgraded = await StateStore.open(ctx.dbPath);

  registerTestCleanup(() => upgraded.stop());

  const reader = new Database(ctx.dbPath, { readonly: true });

  registerTestCleanup(() => {
    reader.close();
  });

  const ledger = reader
    .query<{ name: string }, []>('SELECT name FROM kysely_migration ORDER BY name')
    .all()
    .map((row) => row.name)
    .slice(-10, -7);

  const fleet = await upgraded.loadFleet();
  const dirs = await upgraded.collectSpawnDirs();
  const binding = await upgraded.findAuthBinding(toSessionID('s1'));

  expect(fleet).toStrictEqual([entry]);

  expect(dirs).toStrictEqual([
    { cwd: '/x', grant: { target: 'box', targetIdentity: 'imp:0123456789abcdef' } },
  ]);

  expect(binding).toBeNull();

  expect(ledger).toStrictEqual([
    '025_create_runtime_auth',
    '026_add_fleet_resume_interrupted_turns',
    '027_create_published_record',
  ]);
});

test('it carries every fleet row and column across the rebuild that lets two rows share an agent session id', async () => {
  const ctx = await setupTest();

  const entry = buildMockFleetEntry({
    pinned: true,
    lastAttachedAt: 1000,
    exited: true,
    prompt: 'do it',
    result: 'done',
    transcriptPath: '/t.jsonl',
    model: 'opus',
    effort: 'high',
    target: 'box',
    targetIdentity: 'imp:0123456789abcdef',
    desired: 'sleep',
    hostKey: toSessionID('s-host'),
    authRevision: 2,
  });

  await ctx.store.writeFleet([entry]);
  await ctx.store.stop();

  const older = new Database(ctx.dbPath);

  registerTestCleanup(() => {
    older.close();
  });

  older.run(
    "DELETE FROM kysely_migration WHERE name = '031_rebuild_fleet_without_unique_agent_session_id'",
  );

  older.run('DROP INDEX fleet_agent_session_id');
  older.close();

  const upgraded = await StateStore.open(ctx.dbPath);

  registerTestCleanup(() => upgraded.stop());

  const fleet = await upgraded.loadFleet();

  expect(fleet).toStrictEqual([entry]);
});

test('it records a runtime auth binding as provisioning at its first revision', async () => {
  const ctx = await setupTest();

  await ctx.store.createAuthBinding(
    {
      hostKey: toSessionID('s1'),
      target: 'box',
      targetIdentity: 'imp:0123456789abcdef',
      impName: 'harness-s1',
      bindingHash: 'a'.repeat(64),
      bindingJSON: '{"secrets":[]}',
      attemptID: 'attempt-1',
    },
    1000,
  );

  const binding = await ctx.store.findAuthBinding(toSessionID('s1'));

  expect(binding).toStrictEqual({
    hostKey: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:0123456789abcdef',
    impName: 'harness-s1',
    impID: null,
    revision: 1,
    bindingHash: 'a'.repeat(64),
    bindingJSON: '{"secrets":[]}',
    state: 'provisioning',
    attemptID: 'attempt-1',
    impCreatedByAttempt: false,
    rebind: null,
    createdAt: 1000,
    updatedAt: 1000,
    revokedAt: null,
  });
});

test('it keeps the old revision of a binding whose rebind failed beside the failed attempt', async () => {
  const ctx = await setupTest();

  await ctx.store.createAuthBinding(
    {
      hostKey: toSessionID('s1'),
      target: 'box',
      targetIdentity: 'imp:0123456789abcdef',
      impName: 'atc-s1',
      bindingHash: 'a'.repeat(64),
      bindingJSON: '{"secrets":[]}',
      attemptID: 'attempt-1',
    },
    1000,
  );

  await ctx.store.updateAuthBinding(
    toSessionID('s1'),
    { state: 'ready', impID: 'imp-id-1', impCreatedByAttempt: true },
    2000,
  );

  await ctx.store.updateAuthBinding(
    toSessionID('s1'),
    {
      state: 'rebind_failed',
      rebind: {
        revision: 2,
        bindingHash: 'b'.repeat(64),
        bindingJSON: '{"secrets":["judge"]}',
        attemptID: 'attempt-2',
      },
    },
    3000,
  );

  const binding = await ctx.store.findAuthBinding(toSessionID('s1'));

  expect(binding).toStrictEqual({
    hostKey: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:0123456789abcdef',
    impName: 'atc-s1',
    impID: 'imp-id-1',
    revision: 1,
    bindingHash: 'a'.repeat(64),
    bindingJSON: '{"secrets":[]}',
    state: 'rebind_failed',
    attemptID: 'attempt-1',
    impCreatedByAttempt: true,
    rebind: {
      revision: 2,
      bindingHash: 'b'.repeat(64),
      bindingJSON: '{"secrets":["judge"]}',
      attemptID: 'attempt-2',
    },
    createdAt: 1000,
    updatedAt: 3000,
    revokedAt: null,
  });
});

test('it marks a binding revoked with the time of the revocation', async () => {
  const ctx = await setupTest();

  await ctx.store.createAuthBinding(
    {
      hostKey: toSessionID('s1'),
      target: 'box',
      targetIdentity: 'imp:0123456789abcdef',
      impName: 'atc-s1',
      bindingHash: 'a'.repeat(64),
      bindingJSON: '{"secrets":[]}',
      attemptID: 'attempt-1',
    },
    1000,
  );

  await ctx.store.updateAuthBinding(
    toSessionID('s1'),
    { state: 'revocation_pending', revokedAt: 2000 },
    2000,
  );

  const binding = await ctx.store.findAuthBinding(toSessionID('s1'));

  expect(binding).toStrictEqual({
    hostKey: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'imp:0123456789abcdef',
    impName: 'atc-s1',
    impID: null,
    revision: 1,
    bindingHash: 'a'.repeat(64),
    bindingJSON: '{"secrets":[]}',
    state: 'revocation_pending',
    attemptID: 'attempt-1',
    impCreatedByAttempt: false,
    rebind: null,
    createdAt: 1000,
    updatedAt: 2000,
    revokedAt: 2000,
  });
});

test('it writes a grant row per secret and moves it through its phases in place', async () => {
  const ctx = await setupTest();

  await ctx.store.upsertAuthGrant(
    {
      hostKey: toSessionID('s1'),
      secret: 'judge',
      revision: 1,
      attemptID: 'attempt-1',
      preexisting: false,
      phase: 'granting',
    },
    1000,
  );

  await ctx.store.upsertAuthGrant(
    {
      hostKey: toSessionID('s1'),
      secret: 'glm',
      revision: 1,
      attemptID: 'attempt-1',
      preexisting: true,
      phase: 'granting',
    },
    1000,
  );

  await ctx.store.upsertAuthGrant(
    {
      hostKey: toSessionID('s1'),
      secret: 'judge',
      revision: 1,
      attemptID: 'attempt-1',
      preexisting: false,
      phase: 'granted',
    },
    2000,
  );

  const grants = await ctx.store.collectAuthGrants(toSessionID('s1'));

  expect(grants).toStrictEqual([
    {
      hostKey: toSessionID('s1'),
      secret: 'glm',
      revision: 1,
      attemptID: 'attempt-1',
      preexisting: true,
      phase: 'granting',
      updatedAt: 1000,
    },
    {
      hostKey: toSessionID('s1'),
      secret: 'judge',
      revision: 1,
      attemptID: 'attempt-1',
      preexisting: false,
      phase: 'granted',
      updatedAt: 2000,
    },
  ]);
});

test('it removes a binding and its grants and leaves another host untouched', async () => {
  const ctx = await setupTest();

  await ctx.store.createAuthBinding(
    {
      hostKey: toSessionID('s1'),
      target: 'box',
      targetIdentity: 'imp:0123456789abcdef',
      impName: 'atc-s1',
      bindingHash: 'a'.repeat(64),
      bindingJSON: '{"secrets":[]}',
      attemptID: 'attempt-1',
    },
    1000,
  );

  await ctx.store.createAuthBinding(
    {
      hostKey: toSessionID('s2'),
      target: 'box',
      targetIdentity: 'imp:0123456789abcdef',
      impName: 'atc-s2',
      bindingHash: 'a'.repeat(64),
      bindingJSON: '{"secrets":[]}',
      attemptID: 'attempt-2',
    },
    1000,
  );

  await ctx.store.upsertAuthGrant(
    {
      hostKey: toSessionID('s1'),
      secret: 'glm',
      revision: 1,
      attemptID: 'attempt-1',
      preexisting: false,
      phase: 'granted',
    },
    1000,
  );

  await ctx.store.upsertAuthGrant(
    {
      hostKey: toSessionID('s2'),
      secret: 'glm',
      revision: 1,
      attemptID: 'attempt-2',
      preexisting: false,
      phase: 'granted',
    },
    1000,
  );

  await ctx.store.removeAuthBinding(toSessionID('s1'));

  const removed = await ctx.store.findAuthBinding(toSessionID('s1'));
  const removedGrants = await ctx.store.collectAuthGrants(toSessionID('s1'));
  const kept = await ctx.store.findAuthBinding(toSessionID('s2'));
  const keptGrants = await ctx.store.collectAuthGrants(toSessionID('s2'));

  expect(removed).toBeNull();
  expect(removedGrants).toStrictEqual([]);

  expect(kept).toStrictEqual({
    hostKey: toSessionID('s2'),
    target: 'box',
    targetIdentity: 'imp:0123456789abcdef',
    impName: 'atc-s2',
    impID: null,
    revision: 1,
    bindingHash: 'a'.repeat(64),
    bindingJSON: '{"secrets":[]}',
    state: 'provisioning',
    attemptID: 'attempt-2',
    impCreatedByAttempt: false,
    rebind: null,
    createdAt: 1000,
    updatedAt: 1000,
    revokedAt: null,
  });

  expect(keptGrants).toStrictEqual([
    {
      hostKey: toSessionID('s2'),
      secret: 'glm',
      revision: 1,
      attemptID: 'attempt-2',
      preexisting: false,
      phase: 'granted',
      updatedAt: 1000,
    },
  ]);
});

test('it reconciles a grant a stopped daemon left granting as uncertain and leaves settled grants alone', async () => {
  const ctx = await setupTest();

  await ctx.store.upsertAuthGrant(
    {
      hostKey: toSessionID('s1'),
      secret: 'glm',
      revision: 1,
      attemptID: 'attempt-1',
      preexisting: false,
      phase: 'granting',
    },
    1000,
  );

  await ctx.store.upsertAuthGrant(
    {
      hostKey: toSessionID('s1'),
      secret: 'judge',
      revision: 1,
      attemptID: 'attempt-1',
      preexisting: false,
      phase: 'granted',
    },
    1000,
  );

  const grantsBefore = await ctx.store.collectAuthGrants(toSessionID('s1'));

  await ctx.store.stop();

  const second = await StateStore.open(ctx.dbPath);

  registerTestCleanup(() => second.stop());

  await second.reconcileAuthBindings(5000);

  const grants = await second.collectAuthGrants(toSessionID('s1'));

  expect(grantsBefore.find((grant) => grant.secret === 'glm')?.phase).toBe('granting');

  expect(grants).toStrictEqual([
    {
      hostKey: toSessionID('s1'),
      secret: 'glm',
      revision: 1,
      attemptID: 'attempt-1',
      preexisting: false,
      phase: 'uncertain',
      updatedAt: 5000,
    },
    {
      hostKey: toSessionID('s1'),
      secret: 'judge',
      revision: 1,
      attemptID: 'attempt-1',
      preexisting: false,
      phase: 'granted',
      updatedAt: 1000,
    },
  ]);
});

test('it collects every host binding by host key', async () => {
  const ctx = await setupTest();

  await ctx.store.createAuthBinding(
    {
      hostKey: toSessionID('s2'),
      target: 'box',
      targetIdentity: 'imp:0123456789abcdef',
      impName: 'harness-s2',
      bindingHash: 'a'.repeat(64),
      bindingJSON: '{"secrets":[]}',
      attemptID: 'attempt-s2',
    },
    1000,
  );

  await ctx.store.createAuthBinding(
    {
      hostKey: toSessionID('s1'),
      target: 'box',
      targetIdentity: 'imp:0123456789abcdef',
      impName: 'harness-s1',
      bindingHash: 'a'.repeat(64),
      bindingJSON: '{"secrets":[]}',
      attemptID: 'attempt-s1',
    },
    1000,
  );

  const bindings = await ctx.store.collectAuthBindings();

  expect(bindings).toStrictEqual([
    {
      hostKey: toSessionID('s1'),
      target: 'box',
      targetIdentity: 'imp:0123456789abcdef',
      impName: 'harness-s1',
      impID: null,
      revision: 1,
      bindingHash: 'a'.repeat(64),
      bindingJSON: '{"secrets":[]}',
      state: 'provisioning',
      attemptID: 'attempt-s1',
      impCreatedByAttempt: false,
      rebind: null,
      createdAt: 1000,
      updatedAt: 1000,
      revokedAt: null,
    },
    {
      hostKey: toSessionID('s2'),
      target: 'box',
      targetIdentity: 'imp:0123456789abcdef',
      impName: 'harness-s2',
      impID: null,
      revision: 1,
      bindingHash: 'a'.repeat(64),
      bindingJSON: '{"secrets":[]}',
      state: 'provisioning',
      attemptID: 'attempt-s2',
      impCreatedByAttempt: false,
      rebind: null,
      createdAt: 1000,
      updatedAt: 1000,
      revokedAt: null,
    },
  ]);
});

test('it closes its connection when disposed', async () => {
  const ctx = await setupTest();

  await ctx.store[Symbol.asyncDispose]();

  expect(ctx.store.loadFleet()).rejects.toThrow();
});

test('it stays closed when disposed after a stop', async () => {
  const ctx = await setupTest();

  await ctx.store.stop();

  const disposed = ctx.store[Symbol.asyncDispose]();

  await expect(disposed).toResolve();

  expect(ctx.store.loadFleet()).rejects.toThrow();
});

test('it round-trips a published record', async () => {
  const ctx = await setupTest();

  const record = buildMockPublishedRecord({ session: 's-record' });

  await ctx.store.writePublishedRecord(record);

  const stored = await ctx.store.findPublishedRecord(toSessionID('s-record'));

  expect(stored).toStrictEqual(record);
});

test('it replaces the published record of a session on a second write', async () => {
  const ctx = await setupTest();

  await ctx.store.writePublishedRecord(buildMockPublishedRecord({ session: 's-record' }));

  const later = buildMockPublishedRecord({ session: 's-record', revision: 2 });

  await ctx.store.writePublishedRecord(later);

  const stored = await ctx.store.findPublishedRecord(toSessionID('s-record'));

  expect(stored).toStrictEqual(later);
});

test("it removes one session's published record and keeps another's", async () => {
  const ctx = await setupTest();

  const kept = buildMockPublishedRecord({ session: 's-kept' });

  await ctx.store.writePublishedRecord(buildMockPublishedRecord({ session: 's-gone' }));
  await ctx.store.writePublishedRecord(kept);
  await ctx.store.removePublishedRecord(toSessionID('s-gone'));

  const gone = await ctx.store.findPublishedRecord(toSessionID('s-gone'));
  const stored = await ctx.store.findPublishedRecord(toSessionID('s-kept'));

  expect(gone).toBeNull();
  expect(stored).toStrictEqual(kept);
});

test('it renames reports to notes and accepted to queued in a database from before the rename', async () => {
  const ctx = await setupTest();

  await ctx.store.stop();

  const older = new Database(ctx.dbPath);

  registerTestCleanup(() => {
    older.close();
  });

  older.run('DROP INDEX events_note_id');
  older.run('ALTER TABLE events RENAME COLUMN note_id TO report_id');
  older.run('ALTER TABLE events RENAME COLUMN note_text TO report_text');
  older.run('CREATE UNIQUE INDEX events_report_id ON events (report_id)');

  older.run(
    "INSERT INTO events (ts, atc_id, event, message, kind, report_id, report_text) VALUES ('t1', 's1', 'SessionReport', 'progress', 'report', 'r-1', 'whole text')",
  );

  older.run(
    "INSERT INTO events (ts, atc_id, event, message, kind) VALUES ('t2', 's1', 'SessionMessage', 'm-1', 'message-accepted')",
  );

  older.run(
    "INSERT INTO events (ts, atc_id, event, message, kind) VALUES ('t3', 's1', 'SessionMessage', 'm-2', 'message-delivered')",
  );

  older.run(
    "INSERT INTO messages (id, atc_id, sender, text, status, sent_at) VALUES ('m-1', 's1', 'a', 'hi', 'accepted', 1), ('m-2', 's1', 'a', 'yo', 'delivered', 2)",
  );

  older.run(
    'INSERT INTO idempotency (principal, operation, key, payload_hash, state, effect_ref, result, created_at, updated_at) VALUES ' +
      "('p', 'session.message', 'k-1', 'h', 'completed', 'm-1', '{\"message\":\"m-1\",\"status\":\"accepted\"}', 1, 1), " +
      "('p', 'session.spawn', 'k-2', 'h', 'completed', 's2', '{\"session\":\"s2\"}', 1, 1)",
  );

  older.run(
    "DELETE FROM kysely_migration WHERE name = '028_rename_reports_to_notes_and_accepted_to_queued'",
  );

  older.close();

  const upgraded = await StateStore.open(ctx.dbPath);

  registerTestCleanup(() => upgraded.stop());

  const reader = new Database(ctx.dbPath, { readonly: true });

  registerTestCleanup(() => {
    reader.close();
  });

  const events = reader
    .query<Record<string, string | null>, []>(
      'SELECT event, kind, note_id, note_text FROM events ORDER BY id',
    )
    .all();

  const statuses = reader
    .query<{ status: string }, []>('SELECT status FROM messages ORDER BY id')
    .all()
    .map((row) => row.status);

  const results = reader
    .query<{ result: string }, []>('SELECT result FROM idempotency ORDER BY key')
    .all()
    .map((row) => row.result);

  const indexes = reader
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE name LIKE 'events_%id'")
    .all()
    .map((row) => row.name);

  expect(events).toStrictEqual([
    { event: 'SessionNote', kind: 'note', note_id: 'r-1', note_text: 'whole text' },
    { event: 'SessionMessage', kind: 'message-queued', note_id: null, note_text: null },
    { event: 'SessionMessage', kind: 'message-delivered', note_id: null, note_text: null },
  ]);

  expect(statuses).toStrictEqual(['queued', 'delivered']);
  expect(results).toStrictEqual(['{"message":"m-1","status":"queued"}', '{"session":"s2"}']);
  expect(indexes).toContain('events_note_id');
  expect(indexes).not.toContain('events_report_id');
});
