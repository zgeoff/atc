import { Database } from 'bun:sqlite';
import { expect, mock, test } from 'bun:test';
import { linkSync, readdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { toAgentSessionID, toSessionID } from '@atc/core';
import { StateStore, buildTargetIdentity } from '@atc/store';
import { createMigratedStateDB } from '@atc/store/testing';
import {
  buildMockAgentAdapter,
  buildStubLog,
  registerTestCleanup,
  setupTempDir,
} from '@atc/test-utils';
import { SessionRegistry } from '../sessions/session-registry';
import { buildMockSession } from '../testing/build-mock-session';
import { SessionFleetWriter } from './session-fleet-writer';

// A real state store, an empty registry the test fills with sessions, a
// recorder of logged lines, and the writer over all three.
async function setupTest() {
  const temporaryDirectory = setupTempDir('atc-fleet-writer-');
  const dbPath = join(temporaryDirectory.path, 'state.db');

  await createMigratedStateDB(dbPath);

  const store = await StateStore.open(dbPath);

  registerTestCleanup(() => store.stop());

  const recorder = buildStubLog();

  const registry = new SessionRegistry({
    fallback: buildMockAgentAdapter(),
    adapters: [],
    targets: [],
    targetErrors: [],
    callbacks: { onEvent: mock<() => void>() },
  });

  const statusPath = join(temporaryDirectory.path, 'status.json');

  const writer = new SessionFleetWriter({
    registry,
    store,
    statusPath,
    callbacks: { onChange: mock<() => void>(), log: recorder.log, findRecords: () => null },
  });

  return {
    directory: temporaryDirectory.path,
    dbPath,
    statusPath,
    store,
    registry,
    writer,
    lines: recorder.lines,
  };
}

test('it persists a sub-session link by the parent atc session id', async () => {
  const ctx = await setupTest();

  ctx.registry.sessions.push(
    buildMockSession({
      id: toSessionID('s-c-parent'),
      name: 'wrangler',
      cwd: '/work/proj',
      agentSessionID: toAgentSessionID('c-parent'),
      agent: 'claude',
      kind: 'headless',
      state: 'running',
      target: 'local',
      targetIdentity: buildTargetIdentity('local-pty', {}),
      lastAttachedAt: 1000,
    }),
    buildMockSession({
      id: toSessionID('s-c-child'),
      name: 'worker',
      cwd: '/work/proj',
      agentSessionID: toAgentSessionID('c-child'),
      agent: 'claude',
      kind: 'headless',
      state: 'running',
      parent: toSessionID('s-c-parent'),
      target: 'local',
      targetIdentity: buildTargetIdentity('local-pty', {}),
      lastAttachedAt: 2000,
    }),
  );

  await ctx.writer.writeFleet();

  const stored = await ctx.store.loadFleet();

  expect(stored).toStrictEqual([
    {
      sessionID: toSessionID('s-c-parent'),
      name: 'wrangler',
      cwd: '/work/proj',
      agentSessionID: toAgentSessionID('c-parent'),
      agent: 'claude',
      target: 'local',
      targetIdentity: buildTargetIdentity('local-pty', {}),
      lastAttachedAt: 1000,
    },
    {
      sessionID: toSessionID('s-c-child'),
      name: 'worker',
      cwd: '/work/proj',
      agentSessionID: toAgentSessionID('c-child'),
      agent: 'claude',
      target: 'local',
      targetIdentity: buildTargetIdentity('local-pty', {}),
      lastAttachedAt: 2000,
      parent: toSessionID('s-c-parent'),
    },
  ]);
});

test('it stores a sub-session under a sub-session that resumed their parent agent session', async () => {
  const ctx = await setupTest();

  const parent = buildMockSession({
    id: toSessionID('s-parent'),
    name: 'wrangler',
    agentSessionID: toAgentSessionID('c-parent'),
    target: 'local',
    targetIdentity: buildTargetIdentity('local-pty', {}),
  });

  const child = buildMockSession({
    id: toSessionID('s-child'),
    name: 'worker',
    agentSessionID: toAgentSessionID('c-child'),
    kind: 'headless',
    state: 'running',
    parent: parent.id,
    target: 'local',
    targetIdentity: buildTargetIdentity('local-pty', {}),
  });

  ctx.registry.sessions.push(parent, child);

  await ctx.writer.writeFleet();

  // The resumed session takes the place of the parent whose agent session
  // it resumes, and the sub-session moves under it.
  const resumed = buildMockSession({
    id: toSessionID('s-resumed'),
    name: 'wrangler',
    agentSessionID: toAgentSessionID('c-parent'),
    kind: 'headless',
    state: 'running',
    target: 'local',
    targetIdentity: buildTargetIdentity('local-pty', {}),
  });

  ctx.registry.remove(parent);
  ctx.registry.sessions.push(resumed);

  child.parent = resumed.id;

  await ctx.writer.writeFleet();

  const stored = await ctx.store.loadFleet();

  expect(stored.map((entry) => [entry.sessionID, entry.parent])).toStrictEqual([
    [toSessionID('s-child'), toSessionID('s-resumed')],
    [toSessionID('s-resumed'), undefined],
  ]);
});

test('it persists a session the agent has not yet given a session id', async () => {
  const ctx = await setupTest();

  ctx.registry.sessions.push(
    buildMockSession({
      id: toSessionID('s-booting'),
      name: 'booting',
      cwd: '/work/proj',
      agent: 'claude',
      kind: 'headless',
      state: 'running',
      target: 'local',
      targetIdentity: buildTargetIdentity('local-pty', {}),
      lastAttachedAt: 1000,
    }),
  );

  await ctx.writer.writeFleet();

  const stored = await ctx.store.loadFleet();

  expect(stored).toStrictEqual([
    {
      sessionID: toSessionID('s-booting'),
      name: 'booting',
      cwd: '/work/proj',
      agent: 'claude',
      target: 'local',
      targetIdentity: buildTargetIdentity('local-pty', {}),
      lastAttachedAt: 1000,
    },
  ]);
});

test('it persists a harness kept inside a sleeping host as suspended while the operator still wants it running', async () => {
  const ctx = await setupTest();

  ctx.registry.sessions.push(
    buildMockSession({
      id: toSessionID('s-dozer'),
      name: 'dozer',
      cwd: '/work/proj',
      agentSessionID: toAgentSessionID('c-dozer'),
      agent: 'claude',
      kind: 'pty',
      pty: null,
      state: 'exited',
      desired: 'run',
      vm: 'asleep',
      suspended: true,
      target: 'box',
      targetIdentity: 'imp:0123456789abcdef',
      lastAttachedAt: 1000,
    }),
  );

  await ctx.writer.writeFleet();

  const stored = await ctx.store.loadFleet();

  expect(stored).toStrictEqual([
    {
      sessionID: toSessionID('s-dozer'),
      name: 'dozer',
      cwd: '/work/proj',
      agentSessionID: toAgentSessionID('c-dozer'),
      agent: 'claude',
      exited: true,
      suspended: true,
      target: 'box',
      targetIdentity: 'imp:0123456789abcdef',
      lastAttachedAt: 1000,
    },
  ]);
});

test('it logs a background fleet write that fails and keeps the change in memory', async () => {
  const ctx = await setupTest();

  const session = buildMockSession({ id: toSessionID('s-1'), name: 'renamed' });

  ctx.registry.sessions.push(session);

  // Another connection drops the table, so the store's write fails in SQLite.
  const db = new Database(ctx.dbPath);

  const closeDB = registerTestCleanup(() => {
    db.close();
  });

  db.run('DROP TABLE fleet');

  closeDB();

  const written = await ctx.writer.tryWriteFleet(session.id);

  expect(written).toBeFalse();

  expect(ctx.lines).toStrictEqual([
    'atc fleet write for session s-1 failed (internal): no such table: fleet',
  ]);

  expect(ctx.registry.sessions).toStrictEqual([session]);
  expect(session.name).toBe('renamed');
});

test('it logs a background row update that fails', async () => {
  const ctx = await setupTest();

  // Another connection drops the table, so the store's write fails in SQLite.
  const db = new Database(ctx.dbPath);

  const closeDB = registerTestCleanup(() => {
    db.close();
  });

  db.run('DROP TABLE fleet');

  closeDB();

  const updated = await ctx.writer.tryUpdateFleetEntry(toSessionID('s-1'), {
    result: 'the result',
  });

  expect(updated).toBeFalse();

  expect(ctx.lines).toStrictEqual([
    'atc fleet write for session s-1 failed (internal): no such table: fleet',
  ]);
});

test('it logs nothing for a background fleet write refused as stale_epoch', async () => {
  const ctx = await setupTest();

  ctx.registry.sessions.push(buildMockSession({ id: toSessionID('s-1'), name: 'renamed' }));

  // An owner row from a later ownership epoch, which this daemon's writes
  // may no longer replace.
  const db = new Database(ctx.dbPath);

  const closeDB = registerTestCleanup(() => {
    db.close();
  });

  db.run(
    'INSERT INTO session_owner (session_id, daemon_id, owner_epoch, updated_at) VALUES (?, ?, 2, 0)',
    ['s-1', ctx.store.daemonID],
  );

  closeDB();

  const written = await ctx.writer.tryWriteFleet(toSessionID('s-1'));

  expect(written).toBeFalse();
  expect(ctx.writer.writeFleet()).rejects.toMatchObject({ code: 'stale_epoch' });
  expect(ctx.lines).toStrictEqual([]);
});

test('it writes the state counts and the most urgent session name to the status file', async () => {
  const ctx = await setupTest();

  ctx.registry.sessions.push(
    buildMockSession({ name: 'busy', state: 'running' }),
    buildMockSession({ name: 'blocked', state: 'needs_you' }),
    buildMockSession({ name: 'gone', state: 'exited' }),
  );

  ctx.writer.writeStatus();

  const status = await readFile(ctx.statusPath, 'utf8');

  expect(JSON.parse(status)).toStrictEqual({
    needs_you: 1,
    running: 1,
    done: 0,
    exited: 1,
    urgent: 'blocked',
  });
});

test('it replaces the status file through a temporary file and a rename', async () => {
  const ctx = await setupTest();

  writeFileSync(ctx.statusPath, '{"needs_you":2}');

  // A second name for the old file stands in for a reader that opened it
  // before the write: an in-place write would change what it reads.
  linkSync(ctx.statusPath, join(ctx.directory, 'status.before'));

  ctx.registry.sessions.push(buildMockSession({ name: 'busy', state: 'running' }));
  ctx.writer.writeStatus();

  const before = await readFile(join(ctx.directory, 'status.before'), 'utf8');
  const status = await readFile(ctx.statusPath, 'utf8');

  expect(before).toBe('{"needs_you":2}');

  expect(JSON.parse(status)).toStrictEqual({
    needs_you: 0,
    running: 1,
    done: 0,
    exited: 0,
    urgent: null,
  });

  expect(readdirSync(ctx.directory)).toSatisfyAll((name: string) => !name.endsWith('.tmp'));
});

test('it writes no urgent session to the status file when none needs the user', async () => {
  const ctx = await setupTest();

  ctx.registry.sessions.push(buildMockSession({ name: 'busy', state: 'running' }));
  ctx.writer.writeStatus();

  const status = await readFile(ctx.statusPath, 'utf8');

  expect(JSON.parse(status)).toStrictEqual({
    needs_you: 0,
    running: 1,
    done: 0,
    exited: 0,
    urgent: null,
  });
});
