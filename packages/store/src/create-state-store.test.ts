import { Database } from 'bun:sqlite';
import { expect, mock, onTestFinished, test } from 'bun:test';
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  buildMockPublishedRecord,
  buildMockRestartResult,
  createMigratedStateDB,
  readQueryPlan,
  registerTestCleanup,
  setupTempDir,
  waitFor,
} from '@atc/test-utils';
import { toAgentSessionID, toMessageID, toSessionID } from '@atcx/contract';
import { buildSQLiteDialect } from '@zgeoff/kysely-bun-sqlite';
import { Kysely } from 'kysely';
import type { CompiledQuery } from 'kysely';
import { Migrator } from 'kysely/migration';
import invariant from 'tiny-invariant';
import { z } from 'zod';
import { buildTargetIdentity } from './build-target-identity';
import { createStateStore } from './create-state-store';
import { MIGRATIONS } from './sqlite/migrations';
import { PreLadderDatabaseError } from './sqlite/pre-ladder-database-error';
import type { StateStoreSchema } from './sqlite/state-store-schema';
import { buildMockFleetEntry } from './testing/build-mock-fleet-entry';
import { buildMockMessageRecord } from './testing/build-mock-message-record';

async function setupTest() {
  const temporaryDirectory = setupTempDir('atc-store-');
  const dbPath = join(temporaryDirectory.path, 'state.db');

  createMigratedStateDB(dbPath);

  const queries: CompiledQuery[] = [];

  const store = await createStateStore(dbPath, (query) => {
    queries.push(query);
  });

  registerTestCleanup(() => store.stop());

  return { directory: temporaryDirectory.path, dbPath, store, queries };
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
    targetIdentity: 'remote:box',
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
    targetIdentity: 'remote:box',
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
    targetIdentity: 'remote:box',
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
    targetIdentity: 'remote:box',
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
    targetIdentity: 'remote:box',
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

  const rows = db.query('SELECT name FROM fleet').all();

  expect(rows).toStrictEqual([{ name: entry.name }]);
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

  const rows = db.query('SELECT atc_id, event, message, session_id FROM events').all();

  expect(rows).toStrictEqual([
    { atc_id: 's1', event: 'Notification', message: 'needs permission', session_id: 'c1' },
  ]);
});

test('it records a hook event whose payload is not an object with no message or session id', async () => {
  const ctx = await setupTest();

  await ctx.store.recordEvent({ atcId: toSessionID('s1'), event: 'Stop', payload: null });

  const db = new Database(ctx.dbPath, { readonly: true });

  registerTestCleanup(() => {
    db.close();
  });

  const rows = db.query('SELECT atc_id, event, message, session_id FROM events').all();

  expect(rows).toStrictEqual([{ atc_id: 's1', event: 'Stop', message: null, session_id: null }]);
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

  const rows = db.query('SELECT atc_id, event, message, session_id FROM events').all();

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

  const recency = await ctx.store.readFleetRecency();

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

  const recency = await ctx.store.readFleetRecency();

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

  const recency = await ctx.store.readFleetRecency();

  expect(recency).toStrictEqual(new Map());
});

test('it lists spawn directories most recent first without duplicates', async () => {
  const ctx = await setupTest();

  await ctx.store.recordSpawnDir('/a', { target: 'local', targetIdentity: 'local-pty:x' }, 1000);
  await ctx.store.recordSpawnDir('/b', { target: 'local', targetIdentity: 'local-pty:x' }, 2000);
  await ctx.store.recordSpawnDir('/a', { target: 'local', targetIdentity: 'local-pty:x' }, 3000);

  const dirs = await ctx.store.readSpawnDirs();

  expect(dirs).toStrictEqual([
    { cwd: '/a', grant: { target: 'local', targetIdentity: 'local-pty:x' } },
    { cwd: '/b', grant: { target: 'local', targetIdentity: 'local-pty:x' } },
  ]);
});

test('it lists a spawn directory once for each target it was spawned on', async () => {
  const ctx = await setupTest();

  await ctx.store.recordSpawnDir('/a', { target: 'local', targetIdentity: 'local-pty:x' }, 1000);
  await ctx.store.recordSpawnDir('/a', { target: 'box', targetIdentity: 'remote:y' }, 2000);
  await ctx.store.recordSpawnDir('/a', { target: 'box', targetIdentity: 'remote:z' }, 3000);

  const dirs = await ctx.store.readSpawnDirs();

  expect(dirs).toStrictEqual([
    { cwd: '/a', grant: { target: 'box', targetIdentity: 'remote:z' } },
    { cwd: '/a', grant: { target: 'box', targetIdentity: 'remote:y' } },
    { cwd: '/a', grant: { target: 'local', targetIdentity: 'local-pty:x' } },
  ]);
});

test('it carries spawn directories from before their target was recorded over as spawns on the default local target', async () => {
  const temporaryDirectory = setupTempDir('atc-store-');
  const dbPath = join(temporaryDirectory.path, 'state.db');

  const older = new Database(dbPath);

  // A synced commit per migration step takes up to 2 s for the ladder.
  older.run('PRAGMA synchronous = OFF');

  registerTestCleanup(() => {
    older.close();
  });

  const db = new Kysely<StateStoreSchema>({ dialect: buildSQLiteDialect(older) });

  await new Migrator({
    db,
    provider: { getMigrations: () => Promise.resolve(MIGRATIONS) },
  }).migrateTo('023_add_events_report_text');

  older.run("INSERT INTO spawn_history (cwd, last_spawn) VALUES ('/old', 1000), ('/older', 500);");
  older.close();

  const store = await createStateStore(dbPath);

  registerTestCleanup(() => store.stop());

  const dirs = await store.readSpawnDirs();

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

test('it round-trips a fleet row with its plugin folders in order', async () => {
  const ctx = await setupTest();

  const entry = buildMockFleetEntry({ pluginDirs: ['/opt/plugins/band', '/srv/plugins/extra'] });

  await ctx.store.writeFleet([entry]);

  const fleet = await ctx.store.loadFleet();

  expect(fleet).toStrictEqual([entry]);
});

test('it loads a fleet row whose stored plugin folders do not read with none', async () => {
  const ctx = await setupTest();

  const entry = buildMockFleetEntry();

  await ctx.store.writeFleet([{ ...entry, pluginDirs: ['/opt/plugins/band'] }]);

  const db = new Database(ctx.dbPath);

  registerTestCleanup(() => {
    db.close();
  });

  db.run("UPDATE fleet SET plugin_dirs = '{not json'");

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

test('it round-trips a fleet row with the agent home its harness launched with', async () => {
  const ctx = await setupTest();

  const homed = buildMockFleetEntry({ agentHome: '/tmp/atc/sessions/s-1/codex-home' });
  const unhomed = buildMockFleetEntry();

  await ctx.store.writeFleet([homed, unhomed]);

  const fleet = await ctx.store.loadFleet();

  expect(fleet).toStrictEqual([homed, unhomed]);
});

test('it round-trips a fleet row with the atc access and the spawner its spawn gave it', async () => {
  const ctx = await setupTest();

  const spawner = buildMockFleetEntry();

  const granted = buildMockFleetEntry({
    atcAccess: ['read', 'spawn'],
    spawner: spawner.sessionID,
  });

  const ungranted = buildMockFleetEntry();

  await ctx.store.writeFleet([spawner, granted, ungranted]);

  const fleet = await ctx.store.loadFleet();

  expect(fleet).toStrictEqual([spawner, granted, ungranted]);
});

test('it reads every stored row that holds an agent session id with the host it ran on', async () => {
  const ctx = await setupTest();

  const host = buildMockFleetEntry({
    agentSessionID: toAgentSessionID('conversation-shared'),
    target: 'box-a',
  });

  const guest = buildMockFleetEntry({
    agentSessionID: toAgentSessionID('conversation-shared'),
    target: 'box-b',
    hostKey: toSessionID('host-elsewhere'),
  });

  const other = buildMockFleetEntry({ agentSessionID: toAgentSessionID('conversation-other') });

  await ctx.store.writeFleet([host, guest, other]);

  const holders = await ctx.store.readAgentSessionHolders(toAgentSessionID('conversation-shared'));

  expect(holders).toIncludeSameMembers([
    { sessionID: host.sessionID, hostKey: host.sessionID },
    { sessionID: guest.sessionID, hostKey: toSessionID('host-elsewhere') },
  ]);
});

test('it loads a fleet row whose stored atc access names an unknown scope as holding no access', async () => {
  const ctx = await setupTest();

  const { atcAccess: _, ...entry } = buildMockFleetEntry({ atcAccess: ['read'] });

  await ctx.store.writeFleet([{ ...entry, atcAccess: ['read'] }]);

  const db = new Database(ctx.dbPath);

  registerTestCleanup(() => {
    db.close();
  });

  db.query('UPDATE fleet SET atc_access = ? WHERE session_id = ?').run(
    '["read","admin"]',
    entry.sessionID,
  );

  const fleet = await ctx.store.loadFleet();

  expect(fleet).toStrictEqual([entry]);
});

test('it round-trips a fleet row whose harness is kept inside a sleeping host', async () => {
  const ctx = await setupTest();

  const asleep = buildMockFleetEntry({ exited: true, suspended: true });
  const awake = buildMockFleetEntry();

  await ctx.store.writeFleet([asleep, awake]);

  const fleet = await ctx.store.loadFleet();

  expect(fleet).toStrictEqual([asleep, awake]);
});

test('it round-trips a fleet row with its execution target and identity', async () => {
  const ctx = await setupTest();

  const remote = buildMockFleetEntry({ target: 'box', targetIdentity: 'remote:0123456789abcdef' });
  const untargeted = buildMockFleetEntry();

  await ctx.store.writeFleet([remote, untargeted]);

  const fleet = await ctx.store.loadFleet();

  expect(fleet).toStrictEqual([remote, untargeted]);
});

test('it adds parent to a fleet row that predates it', async () => {
  const temporaryDirectory = setupTempDir('atc-store-');
  const dbPath = join(temporaryDirectory.path, 'state.db');

  const older = new Database(dbPath);

  // A synced commit per migration step takes up to 2 s for the ladder.
  older.run('PRAGMA synchronous = OFF');

  registerTestCleanup(() => {
    older.close();
  });

  const db = new Kysely<StateStoreSchema>({ dialect: buildSQLiteDialect(older) });

  await new Migrator({
    db,
    provider: { getMigrations: () => Promise.resolve(MIGRATIONS) },
  }).migrateTo('006_add_fleet_exited');

  older.run(
    "INSERT INTO fleet (agent_session_id, name, cwd, pinned, last_attached, agent, exited) VALUES ('c1', 'old', '/x', 0, 555, 'claude', 1)",
  );

  older.close();

  const store = await createStateStore(dbPath);

  registerTestCleanup(() => store.stop());

  const fleet = await store.loadFleet();

  expect(fleet).toStrictEqual([
    {
      sessionID: expect.toSatisfy((id: string) =>
        /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u.test(id),
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

  const second = await createStateStore(ctx.dbPath);

  registerTestCleanup(() => second.stop());

  const agent = await second.loadLastUsedAgent();

  expect(agent).toBe('grok');
});

test('it renames the id column and defaults agent for a store written before both', async () => {
  const temporaryDirectory = setupTempDir('atc-store-');
  const dbPath = join(temporaryDirectory.path, 'state.db');

  const older = new Database(dbPath);

  // A synced commit per migration step takes up to 2 s for the ladder.
  older.run('PRAGMA synchronous = OFF');

  registerTestCleanup(() => {
    older.close();
  });

  const db = new Kysely<StateStoreSchema>({ dialect: buildSQLiteDialect(older) });

  await new Migrator({
    db,
    provider: { getMigrations: () => Promise.resolve(MIGRATIONS) },
  }).migrateTo('001_create_initial_schema');

  older.run("INSERT INTO fleet (claude_id, name, cwd) VALUES ('c1', 'old', '/x')");
  older.close();

  const store = await createStateStore(dbPath);

  registerTestCleanup(() => store.stop());

  const fleet = await store.loadFleet();

  expect(fleet).toStrictEqual([
    {
      sessionID: expect.toSatisfy((id: string) =>
        /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u.test(id),
      ),
      name: 'old',
      cwd: '/x',
      agentSessionID: toAgentSessionID('c1'),
      agent: 'claude',
    },
  ]);
});

test('it adds pinned to a fleet row that predates it', async () => {
  const temporaryDirectory = setupTempDir('atc-store-');
  const dbPath = join(temporaryDirectory.path, 'state.db');

  const older = new Database(dbPath);

  // A synced commit per migration step takes up to 2 s for the ladder.
  older.run('PRAGMA synchronous = OFF');

  registerTestCleanup(() => {
    older.close();
  });

  const db = new Kysely<StateStoreSchema>({ dialect: buildSQLiteDialect(older) });

  await new Migrator({
    db,
    provider: { getMigrations: () => Promise.resolve(MIGRATIONS) },
  }).migrateTo('002_rename_fleet_claude_id_to_agent_session_id');

  older.run("INSERT INTO fleet (agent_session_id, name, cwd) VALUES ('c1', 'old', '/x')");
  older.close();

  const store = await createStateStore(dbPath);

  registerTestCleanup(() => store.stop());

  const fleet = await store.loadFleet();

  expect(fleet).toStrictEqual([
    {
      sessionID: expect.toSatisfy((id: string) =>
        /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u.test(id),
      ),
      name: 'old',
      cwd: '/x',
      agentSessionID: toAgentSessionID('c1'),
      agent: 'claude',
    },
  ]);
});

test('it adds the last-attached time to a fleet row that predates it', async () => {
  const temporaryDirectory = setupTempDir('atc-store-');
  const dbPath = join(temporaryDirectory.path, 'state.db');

  const older = new Database(dbPath);

  // A synced commit per migration step takes up to 2 s for the ladder.
  older.run('PRAGMA synchronous = OFF');

  registerTestCleanup(() => {
    older.close();
  });

  const db = new Kysely<StateStoreSchema>({ dialect: buildSQLiteDialect(older) });

  await new Migrator({
    db,
    provider: { getMigrations: () => Promise.resolve(MIGRATIONS) },
  }).migrateTo('003_add_fleet_pinned');

  older.run(
    "INSERT INTO fleet (agent_session_id, name, cwd, pinned) VALUES ('c1', 'old', '/x', 1)",
  );

  older.close();

  const store = await createStateStore(dbPath);

  registerTestCleanup(() => store.stop());

  const fleet = await store.loadFleet();

  expect(fleet).toStrictEqual([
    {
      sessionID: expect.toSatisfy((id: string) =>
        /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u.test(id),
      ),
      name: 'old',
      cwd: '/x',
      agentSessionID: toAgentSessionID('c1'),
      agent: 'claude',
      pinned: true,
    },
  ]);
});

test('it adds agent to a fleet row that predates it', async () => {
  const temporaryDirectory = setupTempDir('atc-store-');
  const dbPath = join(temporaryDirectory.path, 'state.db');

  const older = new Database(dbPath);

  // A synced commit per migration step takes up to 2 s for the ladder.
  older.run('PRAGMA synchronous = OFF');

  registerTestCleanup(() => {
    older.close();
  });

  const db = new Kysely<StateStoreSchema>({ dialect: buildSQLiteDialect(older) });

  await new Migrator({
    db,
    provider: { getMigrations: () => Promise.resolve(MIGRATIONS) },
  }).migrateTo('004_add_fleet_last_attached');

  older.run(
    "INSERT INTO fleet (agent_session_id, name, cwd, pinned, last_attached) VALUES ('c1', 'old', '/x', 1, 555)",
  );

  older.close();

  const store = await createStateStore(dbPath);

  registerTestCleanup(() => store.stop());

  const fleet = await store.loadFleet();

  expect(fleet).toStrictEqual([
    {
      sessionID: expect.toSatisfy((id: string) =>
        /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u.test(id),
      ),
      name: 'old',
      cwd: '/x',
      agentSessionID: toAgentSessionID('c1'),
      agent: 'claude',
      pinned: true,
      lastAttachedAt: 555,
    },
  ]);
});

test('it adds exited to a fleet row that predates it', async () => {
  const temporaryDirectory = setupTempDir('atc-store-');
  const dbPath = join(temporaryDirectory.path, 'state.db');

  const older = new Database(dbPath);

  // A synced commit per migration step takes up to 2 s for the ladder.
  older.run('PRAGMA synchronous = OFF');

  registerTestCleanup(() => {
    older.close();
  });

  const db = new Kysely<StateStoreSchema>({ dialect: buildSQLiteDialect(older) });

  await new Migrator({
    db,
    provider: { getMigrations: () => Promise.resolve(MIGRATIONS) },
  }).migrateTo('005_add_fleet_agent');

  older.run(
    "INSERT INTO fleet (agent_session_id, name, cwd, pinned, last_attached, agent) VALUES ('c1', 'old', '/x', 1, 555, 'grok')",
  );

  older.close();

  const store = await createStateStore(dbPath);

  registerTestCleanup(() => store.stop());

  const fleet = await store.loadFleet();

  expect(fleet).toStrictEqual([
    {
      sessionID: expect.toSatisfy((id: string) =>
        /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u.test(id),
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

test('it runs every migration once on the first open of a fresh database', async () => {
  const temporaryDirectory = setupTempDir('atc-store-');
  const dbPath = join(temporaryDirectory.path, 'state.db');

  const store = await createStateStore(dbPath);

  registerTestCleanup(() => store.stop());

  await store.stop();

  const ledger = new Database(dbPath, { readonly: true });

  registerTestCleanup(() => {
    ledger.close();
  });

  const names = ledger.query('SELECT name FROM kysely_migration ORDER BY name').values().flat();

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
    '035_add_fleet_suspended',
    '036_add_fleet_plugin_dirs',
    '037_drop_fleet_resume_interrupted_turns',
    '038_rename_runtime_auth_binding_host_columns',
    '039_rename_workspace_materialization_dir_to_directory',
    '040_create_restart_results',
    '041_add_fleet_agent_home',
    '042_add_fleet_atc_access',
  ]);
});

test('it adds the restart results table and leaves every row of an older database as it was', async () => {
  const temporaryDirectory = setupTempDir('atc-store-');
  const dbPath = join(temporaryDirectory.path, 'state.db');

  const older = new Database(dbPath);

  // A synced commit per migration step takes up to 2 s for the ladder.
  older.run('PRAGMA synchronous = OFF');

  registerTestCleanup(() => {
    older.close();
  });

  const db = new Kysely<StateStoreSchema>({ dialect: buildSQLiteDialect(older) });

  await new Migrator({
    db,
    provider: { getMigrations: () => Promise.resolve(MIGRATIONS) },
  }).migrateTo('039_rename_workspace_materialization_dir_to_directory');

  older.run(
    "INSERT INTO fleet (session_id, name, cwd, pinned, agent, exited) VALUES ('s-lark', 'nightly-lint', '/work/lint', 0, 'claude', 0)",
  );

  older.run(
    "INSERT INTO events (ts, atc_id, event, message, session_id, kind, detail) VALUES ('2026-03-01T08:00:00.000Z', 's-lark', 'Stop', NULL, 'agent-lark', 'turn-done', 'lint clean')",
  );

  const tablesBefore = older
    .query("SELECT name, sql FROM sqlite_master WHERE type IN ('table', 'index') ORDER BY name")
    .all();

  const fleetBefore = older.query('SELECT * FROM fleet').all();
  const eventsBefore = older.query('SELECT * FROM events').all();

  await new Migrator({
    db,
    provider: { getMigrations: () => Promise.resolve(MIGRATIONS) },
  }).migrateTo('040_create_restart_results');

  older.close();

  const reader = new Database(dbPath, { readonly: true });

  registerTestCleanup(() => {
    reader.close();
  });

  const tablesAfter = reader
    .query("SELECT name, sql FROM sqlite_master WHERE type IN ('table', 'index') ORDER BY name")
    .all();

  expect(tablesAfter).toIncludeSameMembers([
    ...tablesBefore,
    {
      name: 'restart_results',
      sql: 'CREATE TABLE "restart_results" ("event_id" integer primary key, "result" text not null)',
    },
  ]);

  expect(reader.query('SELECT * FROM fleet').all()).toStrictEqual(fleetBefore);
  expect(reader.query('SELECT * FROM events').all()).toStrictEqual(eventsBefore);
  expect(reader.query('SELECT * FROM restart_results').all()).toStrictEqual([]);
});

test('it drops the resume column from a database that stopped at the step that added it, and keeps its fleet', async () => {
  const temporaryDirectory = setupTempDir('atc-store-');
  const dbPath = join(temporaryDirectory.path, 'state.db');

  const older = new Database(dbPath);

  // A synced commit per migration step takes up to 2 s for the ladder.
  older.run('PRAGMA synchronous = OFF');

  registerTestCleanup(() => {
    older.close();
  });

  const db = new Kysely<StateStoreSchema>({ dialect: buildSQLiteDialect(older) });

  await new Migrator({
    db,
    provider: { getMigrations: () => Promise.resolve(MIGRATIONS) },
  }).migrateTo('026_add_fleet_resume_interrupted_turns');

  older.run(
    "INSERT INTO fleet (session_id, name, cwd, pinned, agent, exited, resume_interrupted_turns) VALUES ('s-1', 'nightly-build', '/work/app', 0, 'claude', 0, 1)",
  );

  older.close();

  const upgraded = await createStateStore(dbPath);

  registerTestCleanup(() => upgraded.stop());

  const reader = new Database(dbPath, { readonly: true });

  registerTestCleanup(() => {
    reader.close();
  });

  const columns = z
    .array(z.object({ name: z.string() }))
    .parse(reader.query('PRAGMA table_info(fleet)').all())
    .map((column) => column.name);

  const rows = reader.query('SELECT session_id, name FROM fleet').all();

  expect(columns).not.toContain('resume_interrupted_turns');
  expect(rows).toStrictEqual([{ session_id: 's-1', name: 'nightly-build' }]);
});

test('it records the resume column drop and keeps the fleet when a crash left the column dropped but the step unrecorded', async () => {
  const temporaryDirectory = setupTempDir('atc-store-');
  const dbPath = join(temporaryDirectory.path, 'state.db');

  const older = new Database(dbPath);

  // A synced commit per migration step takes up to 2 s for the ladder.
  older.run('PRAGMA synchronous = OFF');

  registerTestCleanup(() => {
    older.close();
  });

  const db = new Kysely<StateStoreSchema>({ dialect: buildSQLiteDialect(older) });

  await new Migrator({
    db,
    provider: { getMigrations: () => Promise.resolve(MIGRATIONS) },
  }).migrateTo('036_add_fleet_plugin_dirs');

  older.run(
    "INSERT INTO fleet (session_id, name, cwd, pinned, agent, exited) VALUES ('s-1', 'nightly-build', '/work/app', 0, 'claude', 0)",
  );

  older.run('ALTER TABLE fleet DROP COLUMN resume_interrupted_turns');
  older.close();

  const upgraded = await createStateStore(dbPath);

  registerTestCleanup(() => upgraded.stop());

  const reader = new Database(dbPath, { readonly: true });

  registerTestCleanup(() => {
    reader.close();
  });

  const steps = reader
    .query(
      "SELECT name FROM kysely_migration WHERE name = '037_drop_fleet_resume_interrupted_turns'",
    )
    .all();

  const rows = reader.query('SELECT session_id, name FROM fleet').all();

  expect(steps).toStrictEqual([{ name: '037_drop_fleet_resume_interrupted_turns' }]);
  expect(rows).toStrictEqual([{ session_id: 's-1', name: 'nightly-build' }]);
});

test('it reads a runtime auth binding bound before the host column rename as the same binding after it', async () => {
  const temporaryDirectory = setupTempDir('atc-store-');
  const dbPath = join(temporaryDirectory.path, 'state.db');

  const older = new Database(dbPath);

  // A synced commit per migration step takes up to 2 s for the ladder.
  older.run('PRAGMA synchronous = OFF');

  registerTestCleanup(() => {
    older.close();
  });

  const db = new Kysely<StateStoreSchema>({ dialect: buildSQLiteDialect(older) });

  await new Migrator({
    db,
    provider: { getMigrations: () => Promise.resolve(MIGRATIONS) },
  }).migrateTo('037_drop_fleet_resume_interrupted_turns');

  older.run(
    `INSERT INTO runtime_auth_binding (host_key, target, target_identity, imp_name, imp_id, revision, binding_hash, binding_json, state, attempt_id, imp_created_by_attempt, rebind_revision, rebind_binding_hash, rebind_binding_json, rebind_attempt_id, created_at, updated_at, revoked_at) VALUES ('s1', 'box', 'remote:0123456789abcdef', 'atc-s1', 'host-id-1', 2, '${'a'.repeat(64)}', '{"secrets":["glm"]}', 'ready', 'attempt-2', 1, NULL, NULL, NULL, NULL, 1000, 2000, NULL)`,
  );

  older.close();

  const upgraded = await createStateStore(dbPath);

  registerTestCleanup(() => upgraded.stop());

  const binding = await upgraded.readAuthBinding(toSessionID('s1'));

  expect(binding).toStrictEqual({
    hostKey: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'remote:0123456789abcdef',
    hostName: 'atc-s1',
    hostID: 'host-id-1',
    revision: 2,
    bindingHash: 'a'.repeat(64),
    bindingJSON: '{"secrets":["glm"]}',
    state: 'ready',
    attemptID: 'attempt-2',
    hostCreatedByAttempt: true,
    rebind: null,
    createdAt: 1000,
    updatedAt: 2000,
    revokedAt: null,
  });
});

test('it finishes the host column rename and keeps the binding when a crash left one column renamed but the step unrecorded', async () => {
  const temporaryDirectory = setupTempDir('atc-store-');
  const dbPath = join(temporaryDirectory.path, 'state.db');

  const older = new Database(dbPath);

  // A synced commit per migration step takes up to 2 s for the ladder.
  older.run('PRAGMA synchronous = OFF');

  registerTestCleanup(() => {
    older.close();
  });

  const db = new Kysely<StateStoreSchema>({ dialect: buildSQLiteDialect(older) });

  await new Migrator({
    db,
    provider: { getMigrations: () => Promise.resolve(MIGRATIONS) },
  }).migrateTo('037_drop_fleet_resume_interrupted_turns');

  older.run(
    `INSERT INTO runtime_auth_binding (host_key, target, target_identity, imp_name, imp_id, revision, binding_hash, binding_json, state, attempt_id, imp_created_by_attempt, created_at, updated_at) VALUES ('s1', 'box', 'remote:0123456789abcdef', 'atc-s1', NULL, 1, '${'a'.repeat(64)}', '{"secrets":[]}', 'provisioning', 'attempt-1', 0, 1000, 1000)`,
  );

  older.run('ALTER TABLE runtime_auth_binding RENAME COLUMN imp_name TO host_name');
  older.close();

  const upgraded = await createStateStore(dbPath);

  registerTestCleanup(() => upgraded.stop());

  const binding = await upgraded.readAuthBinding(toSessionID('s1'));

  expect(binding).toStrictEqual({
    hostKey: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'remote:0123456789abcdef',
    hostName: 'atc-s1',
    hostID: null,
    revision: 1,
    bindingHash: 'a'.repeat(64),
    bindingJSON: '{"secrets":[]}',
    state: 'provisioning',
    attemptID: 'attempt-1',
    hostCreatedByAttempt: false,
    rebind: null,
    createdAt: 1000,
    updatedAt: 1000,
    revokedAt: null,
  });
});

test('it renames the workspace directory column and keeps the workspace of a database that stopped before the rename', async () => {
  const temporaryDirectory = setupTempDir('atc-store-');
  const dbPath = join(temporaryDirectory.path, 'state.db');

  const older = new Database(dbPath);

  // A synced commit per migration step takes up to 2 s for the ladder.
  older.run('PRAGMA synchronous = OFF');

  registerTestCleanup(() => {
    older.close();
  });

  const db = new Kysely<StateStoreSchema>({ dialect: buildSQLiteDialect(older) });

  await new Migrator({
    db,
    provider: { getMigrations: () => Promise.resolve(MIGRATIONS) },
  }).migrateTo('038_rename_runtime_auth_binding_host_columns');

  older.run(
    `INSERT INTO workspace_materialization (session_id, target, dir, source_kind, phase, repo_url, sha, ref, error_code, started_at, updated_at, materialized_at, withheld_env) VALUES ('s-ws', 'box', '/w/s-ws', 'path', 'ready', NULL, NULL, NULL, NULL, 1000, 2000, 2000, '[]')`,
  );

  older.close();

  const upgraded = await createStateStore(dbPath);

  registerTestCleanup(() => upgraded.stop());

  const row = await upgraded.readMaterialization(toSessionID('s-ws'));

  expect(row).toStrictEqual({
    sessionID: toSessionID('s-ws'),
    target: 'box',
    directory: '/w/s-ws',
    sourceKind: 'path',
    phase: 'ready',
    repoURL: null,
    sha: null,
    ref: null,
    errorCode: null,
    startedAt: 1000,
    updatedAt: 2000,
    materializedAt: 2000,
    withheldEnv: [],
  });
});

test('it keeps the workspace when a crash left the directory column renamed but the step unrecorded', async () => {
  const temporaryDirectory = setupTempDir('atc-store-');
  const dbPath = join(temporaryDirectory.path, 'state.db');

  const older = new Database(dbPath);

  // A synced commit per migration step takes up to 2 s for the ladder.
  older.run('PRAGMA synchronous = OFF');

  registerTestCleanup(() => {
    older.close();
  });

  const db = new Kysely<StateStoreSchema>({ dialect: buildSQLiteDialect(older) });

  await new Migrator({
    db,
    provider: { getMigrations: () => Promise.resolve(MIGRATIONS) },
  }).migrateTo('038_rename_runtime_auth_binding_host_columns');

  older.run(
    `INSERT INTO workspace_materialization (session_id, target, dir, source_kind, phase, repo_url, sha, ref, error_code, started_at, updated_at, materialized_at, withheld_env) VALUES ('s-ws', 'box', '/w/s-ws', 'path', 'ready', NULL, NULL, NULL, NULL, 1000, 2000, 2000, '[]')`,
  );

  older.run('ALTER TABLE workspace_materialization RENAME COLUMN dir TO directory');
  older.close();

  const upgraded = await createStateStore(dbPath);

  registerTestCleanup(() => upgraded.stop());

  const row = await upgraded.readMaterialization(toSessionID('s-ws'));

  expect(row).toMatchObject({ sessionID: toSessionID('s-ws'), directory: '/w/s-ws' });
});

test('it re-runs no migration when it reopens a migrated database', async () => {
  const temporaryDirectory = setupTempDir('atc-store-');
  const dbPath = join(temporaryDirectory.path, 'state.db');

  const first = await createStateStore(dbPath);

  registerTestCleanup(() => first.stop());

  await first.stop();

  const ledger = new Database(dbPath);

  registerTestCleanup(() => {
    ledger.close();
  });

  ledger.run("UPDATE kysely_migration SET timestamp = 'sentinel'");

  const second = await createStateStore(dbPath);

  registerTestCleanup(() => second.stop());

  await second.stop();

  const stamps = ledger.query('SELECT timestamp FROM kysely_migration').values().flat();

  expect(stamps).toStrictEqual(Array.from({ length: 42 }, () => 'sentinel'));
});

test('it keeps the fleet of a migrated database across a reopen', async () => {
  const temporaryDirectory = setupTempDir('atc-store-');
  const dbPath = join(temporaryDirectory.path, 'state.db');

  const older = new Database(dbPath);

  // A synced commit per migration step takes up to 2 s for the ladder.
  older.run('PRAGMA synchronous = OFF');

  registerTestCleanup(() => {
    older.close();
  });

  const db = new Kysely<StateStoreSchema>({ dialect: buildSQLiteDialect(older) });

  await new Migrator({
    db,
    provider: { getMigrations: () => Promise.resolve(MIGRATIONS) },
  }).migrateTo('001_create_initial_schema');

  older.run("INSERT INTO fleet (claude_id, name, cwd) VALUES ('c1', 'first', '/x')");
  older.close();

  const first = await createStateStore(dbPath);

  registerTestCleanup(() => first.stop());

  const added = buildMockFleetEntry();

  await first.writeFleet([...(await first.loadFleet()), added]);
  await first.stop();

  const second = await createStateStore(dbPath);

  registerTestCleanup(() => second.stop());

  const fleet = await second.loadFleet();

  expect(fleet).toStrictEqual([
    {
      sessionID: expect.toSatisfy((id: string) =>
        /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u.test(id),
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
  const temporaryDirectory = setupTempDir('atc-store-');
  const freshPath = join(temporaryDirectory.path, 'fresh.db');
  const oldPath = join(temporaryDirectory.path, 'old.db');

  const old = new Database(oldPath);

  // A synced commit per migration step takes up to 2 s for the ladder.
  old.run('PRAGMA synchronous = OFF');

  registerTestCleanup(() => {
    old.close();
  });

  await new Migrator({
    db: new Kysely<StateStoreSchema>({ dialect: buildSQLiteDialect(old) }),
    provider: { getMigrations: () => Promise.resolve(MIGRATIONS) },
  }).migrateTo('007_add_fleet_parent');

  old.close();

  const freshStore = await createStateStore(freshPath);

  registerTestCleanup(() => freshStore.stop());

  const oldStore = await createStateStore(oldPath);

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
    z
      .array(z.object({ name: z.string() }))
      .parse(db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all())
      .map((row) => row.name)
      .toSorted()
      .map((table) => ({
        table,
        columns: z
          .array(
            z.object({
              name: z.string(),
              type: z.string(),
              notnull: z.number(),
              dflt_value: z.unknown(),
            }),
          )
          .parse(db.query(`PRAGMA table_info(${table})`).all())
          .toSorted((left, right) => left.name.localeCompare(right.name)),
      })),
  );

  expect(freshSchema).toStrictEqual(oldSchema);
});

test('it refuses a database that holds a fleet table but no migration ledger', () => {
  const temporaryDirectory = setupTempDir('atc-store-');
  const dbPath = join(temporaryDirectory.path, 'state.db');

  const db = new Database(dbPath);

  registerTestCleanup(() => {
    db.close();
  });

  db.run('CREATE TABLE fleet (claude_id TEXT PRIMARY KEY, name TEXT NOT NULL, cwd TEXT NOT NULL);');
  db.run("INSERT INTO fleet (claude_id, name, cwd) VALUES ('c1', 'first', '/x')");
  db.close();

  expect(createStateStore(dbPath)).rejects.toThrowWithMessage(
    PreLadderDatabaseError,
    'the state database predates the migration ladder; start atc 4.15.0 against it once to migrate it, then start this release',
  );
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

  const events = await ctx.store.readLatestEvents(10);

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

  const events = await ctx.store.readLatestEvents(10);

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

  const events = await ctx.store.readLatestEvents(10);

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

  const [first] = await ctx.store.readLatestEvents(10);

  invariant(first !== undefined, 'expected events');

  const after = await ctx.store.readEventsAfter(first.id, 1);

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

  const latest = await ctx.store.readLatestEvents(2);

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

  await ctx.store.readEventsAfter(5, 5);

  const query = ctx.queries.at(-1);

  invariant(query !== undefined, 'the store ran no query');

  const plan = readQueryPlan(ctx.dbPath, query);

  expect(plan).toInclude('USING INDEX events_trail');
});

test('it serves the latest trail read from an index', async () => {
  const ctx = await setupTest();

  await ctx.store.readLatestEvents(5);

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

  const rows = db.query('SELECT ts, kind FROM events').all();

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

  const rows = db.query('SELECT ts, kind FROM events').all();

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

  const rows = db.query('SELECT atc_id, ts FROM events').all();

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

  const rows = db.query('SELECT id FROM events').all();

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

  const rows = db.query('SELECT ts, kind FROM events').all();

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

  const rows = db.query('SELECT atc_id, kind FROM events').all();

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

  const [latest] = await ctx.store.readLatestEvents(1);
  const [cursor] = await ctx.store.readEventsAfter(0, 1);

  invariant(latest !== undefined && cursor !== undefined, 'expected events');

  await ctx.store.removeExpiredEvents(Date.parse('2026-01-31T00:00:00.000Z'));

  const after = await ctx.store.readEventsAfter(cursor.id, 10);

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

  const query = ctx.queries.find((candidate) => candidate.sql.startsWith('delete from "events"'));

  invariant(query !== undefined, 'the store ran no delete from the events table');

  const plan = readQueryPlan(ctx.dbPath, query);

  expect(plan).toInclude('USING COVERING INDEX events_atc_id_ts');
  expect(plan).toInclude('USING COVERING INDEX events_session_id_ts');
});

test('it lists a queued message as pending for the session it was sent to', async () => {
  const ctx = await setupTest();

  const record = buildMockMessageRecord();

  await ctx.store.writeMessage(record);

  const pending = await ctx.store.readPendingMessages({ atcID: record.atcID });

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

  const pending = await ctx.store.readPendingMessages({ atcID: toSessionID('s1') });

  expect(pending).toStrictEqual([first, second, third]);
});

test('it finds pending messages by agent session id under a new atc id', async () => {
  const ctx = await setupTest();

  const record = buildMockMessageRecord({
    atcID: toSessionID('s1'),
    agentSessionID: toAgentSessionID('a1'),
  });

  await ctx.store.writeMessage(record);

  const pending = await ctx.store.readPendingMessages({
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

  await ctx.store.updateMessageDelivered(
    delivered.id,
    { atcID: toSessionID('s1') },
    2000,
    (marked) => ({
      at: 2000,
      atcID: marked.atcID,
      agentSessionID: null,
      kind: 'message-delivered',
      message: marked.id,
      detail: 'hi',
    }),
  );

  await ctx.store.updateMessagesAnswered(
    [answered.id],
    { atcID: toSessionID('s1') },
    { answer: 'ok', at: 2000 },
  );

  const unsettled = await ctx.store.readUnsettledMessages({ atcID: toSessionID('s1') });

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
    (marked) => ({
      at: 2000,
      atcID: marked.atcID,
      agentSessionID: null,
      kind: 'message-delivered',
      message: marked.id,
      detail: 'hi',
    }),
  );

  expect(delivered).toStrictEqual({ ...record, status: 'delivered', deliveredAt: 2000 });
});

test('it refuses to deliver a message a second time', async () => {
  const ctx = await setupTest();

  const record = buildMockMessageRecord();

  await ctx.store.writeMessage(record);

  await ctx.store.updateMessageDelivered(record.id, { atcID: record.atcID }, 2000, (marked) => ({
    at: 2000,
    atcID: marked.atcID,
    agentSessionID: null,
    kind: 'message-delivered',
    message: marked.id,
    detail: 'hi',
  }));

  const second = await ctx.store.updateMessageDelivered(
    record.id,
    { atcID: record.atcID },
    3000,
    (marked) => ({
      at: 2000,
      atcID: marked.atcID,
      agentSessionID: null,
      kind: 'message-delivered',
      message: marked.id,
      detail: 'hi',
    }),
  );

  expect(second).toBeNull();
});

test('it writes the delivered mark and its trail entry together', async () => {
  const ctx = await setupTest();

  const record = buildMockMessageRecord();

  await ctx.store.writeMessage(record);

  const delivered = await ctx.store.updateMessageDelivered(
    record.id,
    { atcID: record.atcID },
    2000,
    (marked) => ({
      at: 2000,
      atcID: marked.atcID,
      agentSessionID: null,
      kind: 'message-delivered',
      message: marked.id,
      detail: 'hi',
    }),
  );

  const db = new Database(ctx.dbPath, { readonly: true });

  onTestFinished(() => {
    db.close();
  });

  const message = db.query('SELECT status FROM messages WHERE id = ?').get(record.id);
  const events = db.query('SELECT kind FROM events WHERE message = ?').all(record.id);

  expect(delivered).toStrictEqual({ ...record, status: 'delivered', deliveredAt: 2000 });
  expect(message).toStrictEqual({ status: 'delivered' });
  expect(events).toStrictEqual([{ kind: 'message-delivered' }]);
});

test('it leaves the message undelivered when its trail entry fails to write', async () => {
  const ctx = await setupTest();

  const record = buildMockMessageRecord();

  await ctx.store.writeMessage(record);

  const failure = await ctx.store
    .updateMessageDelivered(record.id, { atcID: record.atcID }, 2000, (marked) => ({
      at: Number.NaN,
      atcID: marked.atcID,
      agentSessionID: null,
      kind: 'message-delivered',
      message: marked.id,
      detail: 'hi',
    }))
    .then(
      () => null,
      (error: unknown) => error,
    );

  const db = new Database(ctx.dbPath, { readonly: true });

  onTestFinished(() => {
    db.close();
  });

  const message = db.query('SELECT status, delivered_at FROM messages WHERE id = ?').get(record.id);
  const events = db.query('SELECT kind FROM events WHERE message = ?').all(record.id);

  expect(failure).toBeInstanceOf(RangeError);
  expect(message).toStrictEqual({ status: 'queued', delivered_at: null });
  expect(events).toStrictEqual([]);
});

test('it writes no trail entry for a mark on a message that is already delivered', async () => {
  const ctx = await setupTest();

  const record = buildMockMessageRecord();
  const buildEntry = mock();

  await ctx.store.writeMessage(record);

  await ctx.store.updateMessageDelivered(record.id, { atcID: record.atcID }, 2000, (marked) => ({
    at: 2000,
    atcID: marked.atcID,
    agentSessionID: null,
    kind: 'message-delivered',
    message: marked.id,
    detail: 'hi',
  }));

  const missed = await ctx.store.updateMessageDelivered(
    record.id,
    { atcID: record.atcID },
    3000,
    buildEntry,
  );

  const db = new Database(ctx.dbPath, { readonly: true });

  onTestFinished(() => {
    db.close();
  });

  const events = db.query('SELECT kind FROM events WHERE message = ?').all(record.id);

  expect(missed).toBeNull();
  expect(buildEntry).not.toHaveBeenCalled();
  expect(events).toHaveLength(1);
});

test('it writes no trail entry for a mark on a message another session owns', async () => {
  const ctx = await setupTest();

  const record = buildMockMessageRecord({ atcID: toSessionID('s1') });
  const buildEntry = mock();

  await ctx.store.writeMessage(record);

  const missed = await ctx.store.updateMessageDelivered(
    record.id,
    { atcID: toSessionID('s2') },
    2000,
    buildEntry,
  );

  const db = new Database(ctx.dbPath, { readonly: true });

  onTestFinished(() => {
    db.close();
  });

  const events = db.query('SELECT kind FROM events WHERE message = ?').all(record.id);

  expect(missed).toBeNull();
  expect(buildEntry).not.toHaveBeenCalled();
  expect(events).toStrictEqual([]);
});

test('it drops a delivered message from the pending list', async () => {
  const ctx = await setupTest();

  const record = buildMockMessageRecord();

  await ctx.store.writeMessage(record);

  await ctx.store.updateMessageDelivered(record.id, { atcID: record.atcID }, 2000, (marked) => ({
    at: 2000,
    atcID: marked.atcID,
    agentSessionID: null,
    kind: 'message-delivered',
    message: marked.id,
    detail: 'hi',
  }));

  const pending = await ctx.store.readPendingMessages({ atcID: record.atcID });

  expect(pending).toStrictEqual([]);
});

test('it moves a delivered message to answered with the final text', async () => {
  const ctx = await setupTest();

  const record = buildMockMessageRecord();

  await ctx.store.writeMessage(record);

  await ctx.store.updateMessageDelivered(record.id, { atcID: record.atcID }, 2000, (marked) => ({
    at: 2000,
    atcID: marked.atcID,
    agentSessionID: null,
    kind: 'message-delivered',
    message: marked.id,
    detail: 'hi',
  }));

  const answered = await ctx.store.updateMessagesAnswered(
    [record.id],
    { atcID: record.atcID },
    { answer: 'done', at: 3000 },
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
    { answer: 'done', at: 3000 },
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

  await ctx.store.updateMessageDelivered(record.id, { atcID: record.atcID }, 2000, (marked) => ({
    at: 2000,
    atcID: marked.atcID,
    agentSessionID: null,
    kind: 'message-delivered',
    message: marked.id,
    detail: 'hi',
  }));

  const marked = await ctx.store.updateMessagesUnanswered(
    [record.id],
    { atcID: record.atcID },
    { reason: 'interrupted', at: 3000, turn: 't1' },
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

  await ctx.store.updateMessagesUnanswered(
    [record.id],
    { atcID: record.atcID },
    { reason: 'error', at: 3000 },
  );

  const answered = await ctx.store.updateMessagesAnswered(
    [record.id],
    { atcID: record.atcID },
    { answer: 'done', at: 4000 },
  );

  expect(answered).toStrictEqual([]);
});

test('it keeps an unanswered message unanswered after a refused answer', async () => {
  const ctx = await setupTest();

  const record = buildMockMessageRecord();

  await ctx.store.writeMessage(record);

  await ctx.store.updateMessagesUnanswered(
    [record.id],
    { atcID: record.atcID },
    { reason: 'error', at: 3000 },
  );

  await ctx.store.updateMessagesAnswered(
    [record.id],
    { atcID: record.atcID },
    { answer: 'done', at: 4000 },
  );

  const found = await ctx.store.readMessage(record.id, { atcID: record.atcID });

  expect(found?.status).toBe('unanswered');
});

test('it refuses to mark an answered message unanswered', async () => {
  const ctx = await setupTest();

  const record = buildMockMessageRecord();

  await ctx.store.writeMessage(record);

  await ctx.store.updateMessagesAnswered(
    [record.id],
    { atcID: record.atcID },
    { answer: 'done', at: 3000 },
  );

  const marked = await ctx.store.updateMessagesUnanswered(
    [record.id],
    { atcID: record.atcID },
    { reason: 'interrupted', at: 4000 },
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
    { reason: 'interrupted', at: 2000 },
  );

  expect(marked).toStrictEqual([]);
});

test('it marks every delivered message of a session unanswered with the given reason', async () => {
  const ctx = await setupTest();

  const record = buildMockMessageRecord({ atcID: toSessionID('s1') });

  await ctx.store.writeMessage(record);

  await ctx.store.updateMessageDelivered(
    record.id,
    { atcID: toSessionID('s1') },
    2000,
    (marked) => ({
      at: 2000,
      atcID: marked.atcID,
      agentSessionID: null,
      kind: 'message-delivered',
      message: marked.id,
      detail: 'hi',
    }),
  );

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

test('it marks every queued and delivered message of a session unanswered', async () => {
  const ctx = await setupTest();

  const queued = buildMockMessageRecord({ id: toMessageID('m-1'), atcID: toSessionID('s1') });

  const delivered = buildMockMessageRecord({
    id: toMessageID('m-2'),
    atcID: toSessionID('s1'),
    sentAt: queued.sentAt + 1,
  });

  await ctx.store.writeMessage(queued);
  await ctx.store.writeMessage(delivered);

  await ctx.store.updateMessageDelivered(
    delivered.id,
    { atcID: toSessionID('s1') },
    2000,
    (marked) => ({
      at: 2000,
      atcID: marked.atcID,
      agentSessionID: null,
      kind: 'message-delivered',
      message: marked.id,
      detail: 'hi',
    }),
  );

  const marked = await ctx.store.updateUnsettledMessagesUnanswered(
    { atcID: toSessionID('s1') },
    'session_ended',
    3000,
  );

  expect(marked).toStrictEqual([
    { ...queued, status: 'unanswered', unansweredAt: 3000, unansweredReason: 'session_ended' },
    {
      ...delivered,
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

  const stored = await ctx.store.readMessageByID(record.id);

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

  const stored = await ctx.store.readMessageByID(record.id);

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

  const stored = await ctx.store.readMessageByID(toMessageID('m-old'));

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
    { answer: 'done', at: 3000 },
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
    { reason: 'interrupted', at: 3000 },
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

  await ctx.store.updateMessageDelivered(record.id, { atcID: record.atcID }, 2000, (marked) => ({
    at: 2000,
    atcID: marked.atcID,
    agentSessionID: null,
    kind: 'message-delivered',
    message: marked.id,
    detail: 'hi',
  }));

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
    { answer: 'done', at: 3000 },
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

  await ctx.store.updateMessagesAnswered(
    [record.id],
    { atcID: record.atcID },
    { answer: 'done', at: 3000 },
  );

  await ctx.store.stop();

  const second = await createStateStore(ctx.dbPath);

  registerTestCleanup(() => second.stop());

  const pending = await second.readPendingNotices(sender);

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

  await ctx.store.updateMessagesAnswered(
    [record.id],
    { atcID: record.atcID },
    { answer: 'done', at: 3000 },
  );

  await ctx.store.stop();

  const second = await createStateStore(ctx.dbPath);

  registerTestCleanup(() => second.stop());

  const again = await second.updateMessagesAnswered(
    [record.id],
    { atcID: record.atcID },
    { answer: 'done again', at: 4000 },
  );

  const pending = await second.readPendingNotices(sender);

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
    { reason: 'interrupted', at: 4000 },
  );

  await ctx.store.updateMessagesUnanswered(
    [first.id],
    { atcID: first.atcID },
    { reason: 'interrupted', at: 5000 },
  );

  await ctx.store.updateMessagesUnanswered(
    [other.id],
    { atcID: other.atcID },
    { reason: 'interrupted', at: 5000 },
  );

  const pending = await ctx.store.readPendingNotices(sender);

  expect(pending.map((x) => x.id)).toStrictEqual([second.id, first.id]);

  const delivered = await ctx.store.updateNoticeDelivered(second.id, sender, 6000);

  expect(delivered?.noticeDeliveredAt).toBe(6000);

  const after = await ctx.store.readPendingNotices(sender);

  expect(after.map((x) => x.id)).toStrictEqual([first.id]);
});

test('it refuses to deliver an answer notice twice or to another sender', async () => {
  const ctx = await setupTest();

  const sender = toSessionID('sender');
  const record = buildMockMessageRecord({ senderSession: sender });

  await ctx.store.writeMessage(record);

  await ctx.store.updateMessagesAnswered(
    [record.id],
    { atcID: record.atcID },
    { answer: 'done', at: 3000 },
  );

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

  await ctx.store.updateMessagesAnswered(
    [record.id],
    { atcID: toSessionID('s1') },
    { answer: 'done', at: 2000 },
  );

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

  await ctx.store.updateMessageDelivered(
    record.id,
    { atcID: toSessionID('s2') },
    2000,
    (marked) => ({
      at: 2000,
      atcID: marked.atcID,
      agentSessionID: null,
      kind: 'message-delivered',
      message: marked.id,
      detail: 'hi',
    }),
  );

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
    (marked) => ({
      at: 2000,
      atcID: marked.atcID,
      agentSessionID: null,
      kind: 'message-delivered',
      message: marked.id,
      detail: 'hi',
    }),
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
    { answer: 'done', at: 2000 },
  );

  expect(updated).toStrictEqual([]);
});

test('it gives messages sent before SessionStart their agent session id', async () => {
  const ctx = await setupTest();

  const record = buildMockMessageRecord({ atcID: toSessionID('s1') });

  await ctx.store.writeMessage(record);
  await ctx.store.updateMessageOwner(toSessionID('s1'), undefined, toAgentSessionID('a1'));

  const found = await ctx.store.readMessage(record.id, {
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

  const found = await ctx.store.readMessage(record.id, {
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

  const second = await createStateStore(ctx.dbPath);

  registerTestCleanup(() => second.stop());

  const pending = await second.readPendingMessages({ atcID: record.atcID });

  expect(pending).toStrictEqual([record]);
});

test('it finds a message for its own session', async () => {
  const ctx = await setupTest();

  const record = buildMockMessageRecord();

  await ctx.store.writeMessage(record);

  const own = await ctx.store.readMessage(record.id, { atcID: record.atcID });

  expect(own).toStrictEqual(record);
});

test('it finds no message for another session', async () => {
  const ctx = await setupTest();

  const record = buildMockMessageRecord({ atcID: toSessionID('s1') });

  await ctx.store.writeMessage(record);

  const other = await ctx.store.readMessage(record.id, { atcID: toSessionID('s2') });

  expect(other).toBeNull();
});

test('it serves the pending messages of an atc id from an index', async () => {
  const ctx = await setupTest();

  await ctx.store.readPendingMessages({ atcID: toSessionID('s1') });

  const query = ctx.queries.at(-1);

  invariant(query !== undefined, 'the store ran no query');

  const plan = readQueryPlan(ctx.dbPath, query);

  expect(plan).toInclude('USING INDEX messages_atc_id_status_sent_at');
});

test('it serves the pending messages of an agent session id from an index', async () => {
  const ctx = await setupTest();

  await ctx.store.readPendingMessages({
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

  const found = await ctx.store.readMessageByID(record.id);

  expect(found).toStrictEqual(record);
});

test('it finds no message for an unknown id', async () => {
  const ctx = await setupTest();

  await ctx.store.writeMessage(buildMockMessageRecord({ id: toMessageID('m-1') }));

  const missing = await ctx.store.readMessageByID(toMessageID('m-2'));

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

  const events = await ctx.store.readLatestEvents(10);

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

  const events = await ctx.store.readLatestEvents(10);

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

  const events = await ctx.store.readLatestEvents(10);

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

  const events = await ctx.store.readLatestEvents(10);

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

  const [event] = await ctx.store.readLatestEvents(1);

  invariant(event !== undefined, 'no event');

  const note = await ctx.store.readNote(event.id);

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

  const [event] = await ctx.store.readLatestEvents(1);

  invariant(event !== undefined, 'no event');

  const note = await ctx.store.readNote(event.id);

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

  const [event] = await ctx.store.readLatestEvents(1);

  invariant(event);

  const note = await ctx.store.readNote(event.id, {
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

  const [event] = await ctx.store.readLatestEvents(1);

  invariant(event !== undefined, 'no event');

  const note = await ctx.store.readNote(event.id, {
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

  const store = await createStateStore(ctx.dbPath);

  registerTestCleanup(() => store.stop());

  const [event] = await store.readLatestEvents(1);

  invariant(event !== undefined, 'no event');

  const note = await store.readNote(event.id);

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

  const [event] = await ctx.store.readLatestEvents(1);

  invariant(event !== undefined, 'no event');

  const answer = await ctx.store.readAnswer(event.id);

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

  const [event] = await ctx.store.readLatestEvents(1);

  invariant(event !== undefined, 'no event');

  const answer = await ctx.store.readAnswer(event.id);

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

  const upgraded = await createStateStore(ctx.dbPath);

  registerTestCleanup(() => upgraded.stop());

  const reader = new Database(ctx.dbPath, { readonly: true });

  registerTestCleanup(() => {
    reader.close();
  });

  const rows = z
    .array(z.object({ id: z.number(), answer_text: z.string().nullable() }))
    .parse(reader.query('SELECT id, answer_text FROM events').all());

  const [row] = rows;

  invariant(row !== undefined, 'no row');

  const answer = await upgraded.readAnswer(row.id);

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

  const events = await ctx.store.readLatestEvents(10);

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

test('it reads a restart with its whole result in order between the hook events around it', async () => {
  const ctx = await setupTest();

  const result = buildMockRestartResult({
    code: 1,
    restored: 1,
    total: 2,
    failed: [{ name: 'heron', id: 's-heron', reason: 'its agent is not configured' }],
  });

  await ctx.store.recordEvent(
    { atcId: toSessionID('s1'), event: 'Stop', payload: {} },
    { kind: 'turn-done' },
    1000,
  );

  await ctx.store.recordRestart(result, 'restored 1 of 2, 1 failed, exit code 1', 2000);

  await ctx.store.recordEvent(
    { atcId: toSessionID('s1'), event: 'SessionStart', payload: {} },
    { kind: 'started' },
    3000,
  );

  const events = await ctx.store.readEventsAfter(0, 10);

  expect(events).toStrictEqual([
    {
      id: expect.toBeNumber(),
      at: 1000,
      atcID: toSessionID('s1'),
      agentSessionID: null,
      kind: 'turn-done',
      detail: null,
    },
    {
      id: expect.toBeNumber(),
      at: 2000,
      atcID: toSessionID(''),
      agentSessionID: null,
      kind: 'daemon-restarted',
      detail: 'restored 1 of 2, 1 failed, exit code 1',
      result,
    },
    {
      id: expect.toBeNumber(),
      at: 3000,
      atcID: toSessionID('s1'),
      agentSessionID: null,
      kind: 'started',
      detail: null,
    },
  ]);
});

test('it reads the latest restart with its whole result', async () => {
  const ctx = await setupTest();

  const result = buildMockRestartResult();

  await ctx.store.recordRestart(result, 'restored 0 of 0', 2000);

  const events = await ctx.store.readLatestEvents(10);

  expect(events).toStrictEqual([
    {
      id: expect.toBeNumber(),
      at: 2000,
      atcID: toSessionID(''),
      agentSessionID: null,
      kind: 'daemon-restarted',
      detail: 'restored 0 of 0',
      result,
    },
  ]);
});

test('it leaves a restart out of a read scoped to sessions', async () => {
  const ctx = await setupTest();

  await ctx.store.recordRestart(buildMockRestartResult(), 'restored 0 of 0', 2000);

  await ctx.store.recordEvent(
    { atcId: toSessionID('s1'), event: 'Stop', payload: {} },
    { kind: 'turn-done' },
    3000,
  );

  const events = await ctx.store.readEventsAfter(0, 10, {
    atcIDs: [toSessionID('s1')],
    agentSessionIDs: [],
  });

  expect(events.map((event) => event.kind)).toStrictEqual(['turn-done']);
});

test('it reads a restart whose stored result no longer parses with its detail alone', async () => {
  const ctx = await setupTest();

  await ctx.store.recordRestart(buildMockRestartResult(), 'restored 0 of 0', 2000);

  const db = new Database(ctx.dbPath);

  registerTestCleanup(() => {
    db.close();
  });

  db.run('UPDATE restart_results SET result = \'{"runID":7}\'');

  const events = await ctx.store.readLatestEvents(10);

  expect(events).toStrictEqual([
    {
      id: expect.toBeNumber(),
      at: 2000,
      atcID: toSessionID(''),
      agentSessionID: null,
      kind: 'daemon-restarted',
      detail: 'restored 0 of 0',
    },
  ]);
});

test('it removes the result of an expired restart and keeps the result of a restart after the cutoff', async () => {
  const ctx = await setupTest();

  await ctx.store.recordRestart(
    buildMockRestartResult({ runID: 'run-old' }),
    'restored 0 of 0',
    Date.parse('2026-02-01T00:00:00.000Z'),
  );

  await ctx.store.recordRestart(
    buildMockRestartResult({ runID: 'run-new' }),
    'restored 0 of 0',
    Date.parse('2026-02-02T00:00:00.000Z'),
  );

  await ctx.store.removeExpiredEvents(Date.parse('2026-02-01T12:00:00.000Z'));

  const db = new Database(ctx.dbPath, { readonly: true });

  registerTestCleanup(() => {
    db.close();
  });

  const results = db
    .query(
      "SELECT events.ts, json_extract(restart_results.result, '$.runID') AS run FROM restart_results LEFT JOIN events ON events.id = restart_results.event_id",
    )
    .all();

  expect(results).toStrictEqual([{ ts: '2026-02-02T00:00:00.000Z', run: 'run-new' }]);
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

  const events = await ctx.store.readLatestEvents(10);

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
    { answer: 'both', at: 3000, turn: 't-1' },
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
    { answer: 'both', at: 3000, turn: 't-1' },
  );

  const oldest = await ctx.store.readMessage(one.id, { atcID: toSessionID('s1') });

  invariant(oldest !== null, 'oldest message missing');

  const siblings = await ctx.store.readTurnSiblings(oldest);

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
    { reason: 'error', at: 3000, turn: 't-1' },
  );

  const unanswered = await ctx.store.readMessage(one.id, { atcID: toSessionID('s1') });

  invariant(unanswered !== null, 'unanswered message missing');

  const siblings = await ctx.store.readTurnSiblings(unanswered);

  expect(siblings).toStrictEqual([]);
});

test('it keeps the turn of a message its turn left unanswered', async () => {
  const ctx = await setupTest();

  const one = buildMockMessageRecord({ atcID: toSessionID('s1'), sentAt: 1000 });

  await ctx.store.writeMessage(one);

  await ctx.store.updateMessagesUnanswered(
    [one.id],
    { atcID: toSessionID('s1') },
    { reason: 'error', at: 3000, turn: 't-1' },
  );

  const unanswered = await ctx.store.readMessage(one.id, { atcID: toSessionID('s1') });

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
    { answer: 'done', at: 3000, turn: 't-1' },
  );

  await ctx.store.updateMessagesUnanswered(
    [unansweredOne.id],
    { atcID: toSessionID('s1') },
    { reason: 'error', at: 3000, turn: 't-1' },
  );

  const answered = await ctx.store.readMessage(answeredOne.id, { atcID: toSessionID('s1') });

  invariant(answered !== null, 'answered message missing');

  const siblings = await ctx.store.readTurnSiblings(answered);

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
    { answer: 'all', at: 2000, turn: 't-1' },
  );

  const answered = await ctx.store.readMessage(first.id, { atcID: toSessionID('s1') });

  invariant(answered !== null, 'first message missing');

  const siblings = await ctx.store.readTurnSiblings(answered);

  expect(siblings).toStrictEqual([
    { id: toMessageID('m-b'), atcID: toSessionID('s1') },
    { id: toMessageID('m-a'), atcID: toSessionID('s1') },
  ]);
});

test('it rebuilds a fleet at the model-and-effort shape keyed by a minted session id', async () => {
  const temporaryDirectory = setupTempDir('atc-store-');
  const dbPath = join(temporaryDirectory.path, 'state.db');

  const older = new Database(dbPath);

  // A synced commit per migration step takes up to 2 s for the ladder.
  older.run('PRAGMA synchronous = OFF');

  registerTestCleanup(() => {
    older.close();
  });

  const db = new Kysely<StateStoreSchema>({ dialect: buildSQLiteDialect(older) });

  await new Migrator({
    db,
    provider: { getMigrations: () => Promise.resolve(MIGRATIONS) },
  }).migrateTo('014_add_fleet_model_effort');

  older.run(
    'INSERT INTO fleet (agent_session_id, name, cwd, pinned, last_attached, agent, exited, parent, prompt, result, transcript_path, model, effort) VALUES ' +
      "('c-parent', 'wrangler', '/x', 1, 555, 'claude', 0, NULL, 'go', 'done', '/t.jsonl', 'opus', 'high'), " +
      "('c-child', 'worker', '/x', 0, NULL, 'claude', 1, 'c-parent', NULL, NULL, NULL, NULL, NULL), " +
      "('c-orphan', 'stray', '/x', 0, NULL, 'grok', 0, 'c-gone', NULL, NULL, NULL, NULL, NULL), " +
      "(NULL, 'unreported', '/x', 0, NULL, 'claude', 1, NULL, NULL, NULL, NULL, NULL, NULL)",
  );

  older.close();

  const store = await createStateStore(dbPath);

  registerTestCleanup(() => store.stop());

  const fleet = await store.loadFleet();

  const reader = new Database(dbPath, { readonly: true });

  registerTestCleanup(() => {
    reader.close();
  });

  const ledger = reader.query('SELECT name FROM kysely_migration').values().flat();
  const parent = fleet.find((entry) => entry.name === 'wrangler');

  invariant(parent !== undefined, 'expected the parent row');

  expect(fleet).toStrictEqual([
    {
      sessionID: expect.toSatisfy((id: string) =>
        /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u.test(id),
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
        /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u.test(id),
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
        /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u.test(id),
      ),
      name: 'stray',
      cwd: '/x',
      agentSessionID: toAgentSessionID('c-orphan'),
      agent: 'grok',
    },
    {
      sessionID: expect.toSatisfy((id: string) =>
        /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u.test(id),
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
    /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u,
  );
});

test('it keeps the same daemon id across a reopen', async () => {
  const ctx = await setupTest();

  const firstID = ctx.store.daemonID;

  await ctx.store.stop();

  const second = await createStateStore(ctx.dbPath);

  registerTestCleanup(() => second.stop());

  expect(second.daemonID).toBe(firstID);
});

test('it records this daemon as the owner of every fleet row it migrates', async () => {
  const temporaryDirectory = setupTempDir('atc-store-');
  const dbPath = join(temporaryDirectory.path, 'state.db');

  const older = new Database(dbPath);

  // A synced commit per migration step takes up to 2 s for the ladder.
  older.run('PRAGMA synchronous = OFF');

  registerTestCleanup(() => {
    older.close();
  });

  const db = new Kysely<StateStoreSchema>({ dialect: buildSQLiteDialect(older) });

  await new Migrator({
    db,
    provider: { getMigrations: () => Promise.resolve(MIGRATIONS) },
  }).migrateTo('007_add_fleet_parent');

  older.run(
    "INSERT INTO fleet (agent_session_id, name, cwd) VALUES ('c1', 'one', '/x'), ('c2', 'two', '/y')",
  );

  older.close();

  const store = await createStateStore(dbPath);

  registerTestCleanup(() => store.stop());

  const daemonID = store.daemonID;

  const fleet = await store.loadFleet();

  await store.stop();

  const reader = new Database(dbPath, { readonly: true });

  registerTestCleanup(() => {
    reader.close();
  });

  const owners = reader.query('SELECT session_id, daemon_id, owner_epoch FROM session_owner').all();

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

  const stored = reader.query('SELECT session_id FROM fleet ORDER BY session_id').values().flat();

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

  const landedBefore = await ctx.store.readIdempotencyKey({ ...claim, key: 'landed' });
  const lostBefore = await ctx.store.readIdempotencyKey({ ...claim, key: 'lost' });

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
  const rowP = buildMockFleetEntry({ agentSessionID: toAgentSessionID('c-p') });
  const rowQ = buildMockFleetEntry({ agentSessionID: toAgentSessionID('c-q') });
  const rowR = buildMockFleetEntry({ agentSessionID: toAgentSessionID('c-p') });

  const rowS = buildMockFleetEntry({
    agentSessionID: toAgentSessionID('c-q'),
    parent: rowP.sessionID,
  });

  await ctx.store.writeFleet([rowP, rowQ, { ...rowR, parent: rowQ.sessionID }, rowS]);

  const fleet = await ctx.store.loadFleet();

  expect(fleet).toStrictEqual([rowR, { ...rowS, parent: rowR.sessionID }]);
});

test('it moves a worker under a row that a resume of its own parent replaced', async () => {
  const ctx = await setupTest();

  const replaced = buildMockFleetEntry({ agentSessionID: toAgentSessionID('c-p') });
  const worker = buildMockFleetEntry({ parent: replaced.sessionID });
  const resumed = buildMockFleetEntry({ agentSessionID: toAgentSessionID('c-p') });

  await ctx.store.writeFleet([replaced, worker, { ...resumed, parent: replaced.sessionID }]);

  const fleet = await ctx.store.loadFleet();

  expect(fleet).toStrictEqual([{ ...worker, parent: resumed.sessionID }, resumed]);
});

test('it writes three resumes crossed in a ring as one top-level row with every other row under it', async () => {
  const ctx = await setupTest();

  // R resumes P under Q, S resumes Q under T, and U resumes T under P, and
  // each replaced row has a worker of its own.
  const rowP = buildMockFleetEntry({ agentSessionID: toAgentSessionID('c-p') });
  const rowQ = buildMockFleetEntry({ agentSessionID: toAgentSessionID('c-q') });
  const rowT = buildMockFleetEntry({ agentSessionID: toAgentSessionID('c-t') });
  const wp = buildMockFleetEntry({ parent: rowP.sessionID });
  const wq = buildMockFleetEntry({ parent: rowQ.sessionID });
  const rowR = buildMockFleetEntry({ agentSessionID: toAgentSessionID('c-p') });
  const rowS = buildMockFleetEntry({ agentSessionID: toAgentSessionID('c-q') });
  const rowU = buildMockFleetEntry({ agentSessionID: toAgentSessionID('c-t') });

  await ctx.store.writeFleet([
    rowP,
    rowQ,
    rowT,
    wp,
    wq,
    { ...rowR, parent: rowQ.sessionID },
    { ...rowS, parent: rowT.sessionID },
    { ...rowU, parent: rowP.sessionID },
  ]);

  const fleet = await ctx.store.loadFleet();

  expect(fleet).toStrictEqual([
    { ...wp, parent: rowR.sessionID },
    { ...wq, parent: rowR.sessionID },
    rowR,
    { ...rowS, parent: rowR.sessionID },
    { ...rowU, parent: rowR.sessionID },
  ]);
});

test("it moves a worker of a replaced row under the parent of the sub-session that took the row's place", async () => {
  const ctx = await setupTest();

  const other = buildMockFleetEntry();
  const replaced = buildMockFleetEntry({ agentSessionID: toAgentSessionID('c-f') });
  const worker = buildMockFleetEntry({ parent: replaced.sessionID });

  const resumed = buildMockFleetEntry({
    agentSessionID: toAgentSessionID('c-f'),
    parent: other.sessionID,
  });

  await ctx.store.writeFleet([other, replaced, worker, resumed]);

  const fleet = await ctx.store.loadFleet();

  expect(fleet).toStrictEqual([other, { ...worker, parent: other.sessionID }, resumed]);
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
      directory: '/w/s-ws',
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

  const row = await ctx.store.readMaterialization(toSessionID('s-ws'));

  expect(row).toStrictEqual({
    sessionID: toSessionID('s-ws'),
    target: 'box',
    directory: '/w/s-ws',
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
      directory: '/w/s-resolving',
      sourceKind: 'path',
      withheldEnv: [],
    },
    1000,
  );

  await ctx.store.createMaterialization(
    {
      sessionID: toSessionID('s-cloning'),
      target: 'box',
      directory: '/w/s-cloning',
      sourceKind: 'path',
      withheldEnv: [],
    },
    1000,
  );

  await ctx.store.createMaterialization(
    {
      sessionID: toSessionID('s-transferring'),
      target: 'box',
      directory: '/w/s-transferring',
      sourceKind: 'path',
      withheldEnv: [],
    },
    1000,
  );

  await ctx.store.createMaterialization(
    {
      sessionID: toSessionID('s-verifying'),
      target: 'box',
      directory: '/w/s-verifying',
      sourceKind: 'path',
      withheldEnv: [],
    },
    1000,
  );

  await ctx.store.createMaterialization(
    {
      sessionID: toSessionID('s-ready'),
      target: 'box',
      directory: '/w/s-ready',
      sourceKind: 'path',
      withheldEnv: [],
    },
    1000,
  );

  await ctx.store.createMaterialization(
    {
      sessionID: toSessionID('s-failed'),
      target: 'box',
      directory: '/w/s-failed',
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

  const resolvingBefore = await ctx.store.readMaterialization(toSessionID('s-resolving'));
  const cloningBefore = await ctx.store.readMaterialization(toSessionID('s-cloning'));
  const transferringBefore = await ctx.store.readMaterialization(toSessionID('s-transferring'));
  const verifyingBefore = await ctx.store.readMaterialization(toSessionID('s-verifying'));

  await ctx.store.stop();

  const second = await createStateStore(ctx.dbPath);

  registerTestCleanup(() => second.stop());

  await second.reconcileMaterializations(5000);

  const resolving = await second.readMaterialization(toSessionID('s-resolving'));
  const cloning = await second.readMaterialization(toSessionID('s-cloning'));
  const transferring = await second.readMaterialization(toSessionID('s-transferring'));
  const verifying = await second.readMaterialization(toSessionID('s-verifying'));
  const ready = await second.readMaterialization(toSessionID('s-ready'));
  const failed = await second.readMaterialization(toSessionID('s-failed'));

  expect(resolvingBefore?.phase).toBe('resolving');
  expect(cloningBefore?.phase).toBe('cloning');
  expect(transferringBefore?.phase).toBe('transferring');
  expect(verifyingBefore?.phase).toBe('verifying');

  expect(resolving).toStrictEqual({
    sessionID: toSessionID('s-resolving'),
    target: 'box',
    directory: '/w/s-resolving',
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
    directory: '/w/s-cloning',
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
    directory: '/w/s-transferring',
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
    directory: '/w/s-verifying',
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
    directory: '/w/s-ready',
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
    directory: '/w/s-failed',
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
      directory: '/w/s-ready',
      sourceKind: 'git',
      withheldEnv: ['APP_GIT_TOKEN', 'GIT_ASKPASS'],
    },
    1000,
  );

  await ctx.store.createMaterialization(
    {
      sessionID: toSessionID('s-verifying'),
      target: 'local',
      directory: '/w/s-verifying',
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
      directory: '/w/s-ready',
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
      directory: '/w/s-ready',
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

  expect(ctx.store.readMaterialization(toSessionID('s-ready'))).rejects.toThrowWithMessage(
    Error,
    "the workspace of session 's-ready' holds a malformed list of withheld variables",
  );
});

test('it upgrades a database from before runtime auth and keeps every existing row', async () => {
  const ctx = await setupTest();

  const entry = buildMockFleetEntry({
    sessionID: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'remote:0123456789abcdef',
  });

  await ctx.store.writeFleet([entry]);

  await ctx.store.recordSpawnDir(
    '/x',
    { target: 'box', targetIdentity: 'remote:0123456789abcdef' },
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

  const upgraded = await createStateStore(ctx.dbPath);

  registerTestCleanup(() => upgraded.stop());

  const reader = new Database(ctx.dbPath, { readonly: true });

  registerTestCleanup(() => {
    reader.close();
  });

  const ledger = reader
    .query('SELECT name FROM kysely_migration ORDER BY name')
    .values()
    .flat()
    .slice(24, 27);

  const fleet = await upgraded.loadFleet();
  const dirs = await upgraded.readSpawnDirs();
  const binding = await upgraded.readAuthBinding(toSessionID('s1'));

  expect(fleet).toStrictEqual([entry]);

  expect(dirs).toStrictEqual([
    { cwd: '/x', grant: { target: 'box', targetIdentity: 'remote:0123456789abcdef' } },
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
    targetIdentity: 'remote:0123456789abcdef',
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

  const upgraded = await createStateStore(ctx.dbPath);

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
      targetIdentity: 'remote:0123456789abcdef',
      hostName: 'harness-s1',
      bindingHash: 'a'.repeat(64),
      bindingJSON: '{"secrets":[]}',
      attemptID: 'attempt-1',
    },
    1000,
  );

  const binding = await ctx.store.readAuthBinding(toSessionID('s1'));

  expect(binding).toStrictEqual({
    hostKey: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'remote:0123456789abcdef',
    hostName: 'harness-s1',
    hostID: null,
    revision: 1,
    bindingHash: 'a'.repeat(64),
    bindingJSON: '{"secrets":[]}',
    state: 'provisioning',
    attemptID: 'attempt-1',
    hostCreatedByAttempt: false,
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
      targetIdentity: 'remote:0123456789abcdef',
      hostName: 'atc-s1',
      bindingHash: 'a'.repeat(64),
      bindingJSON: '{"secrets":[]}',
      attemptID: 'attempt-1',
    },
    1000,
  );

  await ctx.store.updateAuthBinding(
    toSessionID('s1'),
    { state: 'ready', hostID: 'host-id-1', hostCreatedByAttempt: true },
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

  const binding = await ctx.store.readAuthBinding(toSessionID('s1'));

  expect(binding).toStrictEqual({
    hostKey: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'remote:0123456789abcdef',
    hostName: 'atc-s1',
    hostID: 'host-id-1',
    revision: 1,
    bindingHash: 'a'.repeat(64),
    bindingJSON: '{"secrets":[]}',
    state: 'rebind_failed',
    attemptID: 'attempt-1',
    hostCreatedByAttempt: true,
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
      targetIdentity: 'remote:0123456789abcdef',
      hostName: 'atc-s1',
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

  const binding = await ctx.store.readAuthBinding(toSessionID('s1'));

  expect(binding).toStrictEqual({
    hostKey: toSessionID('s1'),
    target: 'box',
    targetIdentity: 'remote:0123456789abcdef',
    hostName: 'atc-s1',
    hostID: null,
    revision: 1,
    bindingHash: 'a'.repeat(64),
    bindingJSON: '{"secrets":[]}',
    state: 'revocation_pending',
    attemptID: 'attempt-1',
    hostCreatedByAttempt: false,
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

  const grants = await ctx.store.readAuthGrants(toSessionID('s1'));

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
      targetIdentity: 'remote:0123456789abcdef',
      hostName: 'atc-s1',
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
      targetIdentity: 'remote:0123456789abcdef',
      hostName: 'atc-s2',
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

  const removed = await ctx.store.readAuthBinding(toSessionID('s1'));
  const removedGrants = await ctx.store.readAuthGrants(toSessionID('s1'));
  const kept = await ctx.store.readAuthBinding(toSessionID('s2'));
  const keptGrants = await ctx.store.readAuthGrants(toSessionID('s2'));

  expect(removed).toBeNull();
  expect(removedGrants).toStrictEqual([]);

  expect(kept).toStrictEqual({
    hostKey: toSessionID('s2'),
    target: 'box',
    targetIdentity: 'remote:0123456789abcdef',
    hostName: 'atc-s2',
    hostID: null,
    revision: 1,
    bindingHash: 'a'.repeat(64),
    bindingJSON: '{"secrets":[]}',
    state: 'provisioning',
    attemptID: 'attempt-2',
    hostCreatedByAttempt: false,
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

  const grantsBefore = await ctx.store.readAuthGrants(toSessionID('s1'));

  await ctx.store.stop();

  const second = await createStateStore(ctx.dbPath);

  registerTestCleanup(() => second.stop());

  await second.reconcileAuthBindings(5000);

  const grants = await second.readAuthGrants(toSessionID('s1'));

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
      targetIdentity: 'remote:0123456789abcdef',
      hostName: 'harness-s2',
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
      targetIdentity: 'remote:0123456789abcdef',
      hostName: 'harness-s1',
      bindingHash: 'a'.repeat(64),
      bindingJSON: '{"secrets":[]}',
      attemptID: 'attempt-s1',
    },
    1000,
  );

  const bindings = await ctx.store.readAuthBindings();

  expect(bindings).toStrictEqual([
    {
      hostKey: toSessionID('s1'),
      target: 'box',
      targetIdentity: 'remote:0123456789abcdef',
      hostName: 'harness-s1',
      hostID: null,
      revision: 1,
      bindingHash: 'a'.repeat(64),
      bindingJSON: '{"secrets":[]}',
      state: 'provisioning',
      attemptID: 'attempt-s1',
      hostCreatedByAttempt: false,
      rebind: null,
      createdAt: 1000,
      updatedAt: 1000,
      revokedAt: null,
    },
    {
      hostKey: toSessionID('s2'),
      target: 'box',
      targetIdentity: 'remote:0123456789abcdef',
      hostName: 'harness-s2',
      hostID: null,
      revision: 1,
      bindingHash: 'a'.repeat(64),
      bindingJSON: '{"secrets":[]}',
      state: 'provisioning',
      attemptID: 'attempt-s2',
      hostCreatedByAttempt: false,
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

// SQLite removes the WAL side files only when the last handle on the
// database closes, so their absence shows the bun:sqlite handle closed.
test('it closes the database handle when stopped', async () => {
  const ctx = await setupTest();

  await ctx.store.stop();

  expect(readdirSync(ctx.directory)).toStrictEqual(['state.db']);
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

  const stored = await ctx.store.readPublishedRecord(toSessionID('s-record'));

  expect(stored).toStrictEqual(record);
});

test('it replaces the published record of a session on a second write', async () => {
  const ctx = await setupTest();

  await ctx.store.writePublishedRecord(buildMockPublishedRecord({ session: 's-record' }));

  const later = buildMockPublishedRecord({ session: 's-record', revision: 2 });

  await ctx.store.writePublishedRecord(later);

  const stored = await ctx.store.readPublishedRecord(toSessionID('s-record'));

  expect(stored).toStrictEqual(later);
});

test("it removes one session's published record and keeps another's", async () => {
  const ctx = await setupTest();

  const kept = buildMockPublishedRecord({ session: 's-kept' });

  await ctx.store.writePublishedRecord(buildMockPublishedRecord({ session: 's-gone' }));
  await ctx.store.writePublishedRecord(kept);
  await ctx.store.removePublishedRecord(toSessionID('s-gone'));

  const gone = await ctx.store.readPublishedRecord(toSessionID('s-gone'));
  const stored = await ctx.store.readPublishedRecord(toSessionID('s-kept'));

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

  const upgraded = await createStateStore(ctx.dbPath);

  registerTestCleanup(() => upgraded.stop());

  const reader = new Database(ctx.dbPath, { readonly: true });

  registerTestCleanup(() => {
    reader.close();
  });

  const events = reader
    .query('SELECT event, kind, note_id, note_text FROM events ORDER BY id')
    .all();

  const statuses = reader.query('SELECT status FROM messages ORDER BY id').values().flat();
  const results = reader.query('SELECT result FROM idempotency ORDER BY key').values().flat();

  const indexes = reader
    .query("SELECT name FROM sqlite_master WHERE name LIKE 'events_%id'")
    .values()
    .flat();

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

test('it writes a backup that a store opens with every fleet row and the same daemon id', async () => {
  const ctx = await setupTest();

  const first = buildMockFleetEntry();
  const second = buildMockFleetEntry({ exited: true });

  await ctx.store.writeFleet([first, second]);

  const backupPath = join(ctx.directory, 'backup.db');

  await ctx.store.writeBackup(backupPath);

  const restored = await createStateStore(backupPath);

  registerTestCleanup(() => restored.stop());

  const fleet = await restored.loadFleet();

  expect(fleet).toStrictEqual([first, second]);
  expect(restored.daemonID).toBe(ctx.store.daemonID);
});

test('it resolves the backup to its size in bytes', async () => {
  const ctx = await setupTest();

  const backupPath = join(ctx.directory, 'backup.db');

  const bytes = await ctx.store.writeBackup(backupPath);

  expect(bytes).toBe(statSync(backupPath).size);
});

test('it writes a backup that only its owner can read or write', async () => {
  const ctx = await setupTest();

  const backupPath = join(ctx.directory, 'backup.db');

  await ctx.store.writeBackup(backupPath);

  expect(statSync(backupPath).mode & 0o777).toBe(0o600);
});

test('it replaces a file already at the backup path', async () => {
  const ctx = await setupTest();

  const entry = buildMockFleetEntry();

  await ctx.store.writeFleet([entry]);

  const backupPath = join(ctx.directory, 'backup.db');

  writeFileSync(backupPath, 'an older backup');

  await ctx.store.writeBackup(backupPath);

  const restored = await createStateStore(backupPath);

  registerTestCleanup(() => restored.stop());

  const fleet = await restored.loadFleet();

  expect(fleet).toStrictEqual([entry]);
});

test.each([[''], ['-wal'], ['-shm'], ['-journal']])(
  'it refuses a backup onto its own database file with suffix %p and leaves the database open',
  async (suffix) => {
    const ctx = await setupTest();

    const entry = buildMockFleetEntry();

    await ctx.store.writeFleet([entry]);

    const refused = ctx.store.writeBackup(`${ctx.dbPath}${suffix}`);

    await Promise.allSettled([refused]);

    const fleet = await ctx.store.loadFleet();

    expect(refused).rejects.toMatchObject({
      code: 'bad_args',
      message: `${ctx.dbPath}${suffix} is the daemon's own database or one of its log files; back up to another path`,
    });

    expect(fleet).toStrictEqual([entry]);
  },
);

test('it refuses a backup onto its own database through a symlinked directory', async () => {
  const ctx = await setupTest();

  const linked = join(ctx.directory, 'linked-state');

  symlinkSync(ctx.directory, linked);

  expect(ctx.store.writeBackup(join(linked, 'state.db'))).rejects.toMatchObject({
    code: 'bad_args',
  });
});

test('it refuses a backup onto the file its database path links to', async () => {
  const temporaryDirectory = setupTempDir('atc-store-linked-');
  const realPath = join(temporaryDirectory.path, 'live.db');
  const linkPath = join(temporaryDirectory.path, 'state.db');

  createMigratedStateDB(realPath);
  symlinkSync(realPath, linkPath);

  const store = await createStateStore(linkPath);

  registerTestCleanup(() => store.stop());

  expect(store.writeBackup(`${realPath}-wal`)).rejects.toMatchObject({ code: 'bad_args' });
});

test('it removes its staging file when the backup cannot reach its path', async () => {
  const ctx = await setupTest();

  const backupPath = join(ctx.directory, 'taken');

  mkdirSync(backupPath);

  expect(ctx.store.writeBackup(backupPath)).rejects.toThrow();
  expect(readdirSync(ctx.directory).filter((name) => name.includes('.partial'))).toStrictEqual([]);
});

test('it writes a consistent backup while another connection commits writes', async () => {
  const ctx = await setupTest();

  const seed = new Database(ctx.dbPath);

  registerTestCleanup(() => {
    seed.close();
  });

  seed.run('CREATE TABLE probe (generation INTEGER NOT NULL, slot INTEGER NOT NULL)');
  seed.run('CREATE TABLE probe_head (generation INTEGER NOT NULL)');
  seed.run('INSERT INTO probe_head VALUES (0)');

  // About 8 MB of pages, so the copy runs long enough for the writer's
  // commits to land while it reads.
  seed.run('CREATE TABLE bulk (data BLOB NOT NULL)');

  seed.run(
    'WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1024) INSERT INTO bulk SELECT randomblob(8192) FROM n',
  );

  const commitLog = join(ctx.directory, 'commits.log');

  // Each transaction adds 20 rows of one generation and moves the head to
  // it, then logs its commit time. It rests after each commit: one that never
  // paused stretched the copy from a tenth of a second to over three.
  const writer = Bun.spawn(
    [
      process.execPath,
      '-e',
      `
        import { Database } from 'bun:sqlite';
        import { appendFileSync } from 'node:fs';
        const db = new Database(process.env.PROBE_DB);
        db.run('PRAGMA busy_timeout = 5000');
        const insert = db.prepare('INSERT INTO probe (generation, slot) VALUES (?, ?)');
        const head = db.prepare('UPDATE probe_head SET generation = ?');
        const commit = db.transaction((generation) => {
          for (let slot = 0; slot < 20; slot++) insert.run(generation, slot);
          head.run(generation);
        });
        for (let generation = 1; ; generation++) {
          commit(generation);
          appendFileSync(process.env.PROBE_LOG, Date.now() + '\\n');
          Bun.sleepSync(1);
        }
      `,
    ],
    { env: { ...process.env, PROBE_DB: ctx.dbPath, PROBE_LOG: commitLog }, stdout: 'ignore' },
  );

  registerTestCleanup(async () => {
    writer.kill('SIGKILL');

    await writer.exited;
  });

  await waitFor(() => {
    expect(readFileSync(commitLog, 'utf8')).toInclude('\n');
  });

  const backupPath = join(ctx.directory, 'backup.db');
  const startedAt = Date.now();

  await ctx.store.writeBackup(backupPath);

  const endedAt = Date.now();

  writer.kill('SIGKILL');

  await writer.exited;

  const commits = readFileSync(commitLog, 'utf8').trim().split('\n').map(Number);

  const backup = new Database(backupPath, { readonly: true });

  registerTestCleanup(() => {
    backup.close();
  });

  const integrity = backup.query('PRAGMA integrity_check').get();

  const head = z
    .object({ generation: z.number() })
    .parse(backup.query('SELECT generation FROM probe_head').get());

  const generations = backup
    .query('SELECT generation, COUNT(*) AS rows FROM probe GROUP BY generation ORDER BY generation')
    .all();

  expect(commits.filter((at) => at > startedAt && at < endedAt)).not.toBeEmpty();
  expect(integrity).toStrictEqual({ integrity_check: 'ok' });
  expect(head.generation).toBeLessThan(commits.length);

  expect(generations).toStrictEqual(
    Array.from({ length: head.generation }, (_, index) => ({ generation: index + 1, rows: 20 })),
  );
});
