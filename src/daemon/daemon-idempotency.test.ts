import { Database } from 'bun:sqlite';
import { expect, mock, onTestFinished, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentAdapter } from '../agents/agent-adapter';
import { REQUEST_PARAM_SCHEMAS } from '../protocol/request-param-schemas';
import { getRecord } from '../shared/get-record';
import { toMessageID } from '../shared/to-message-id';
import { toSessionID } from '../shared/to-session-id';
import { StateStore } from '../store/state-store';
import { buildMockAgentAdapter } from '../test-utils/build-mock-agent-adapter';
import { buildStubFailingAgentAdapter } from '../test-utils/build-stub-failing-agent-adapter';
import { buildStubSoftKillProvider } from '../test-utils/build-stub-soft-kill-provider';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { startTestDaemon } from '../test-utils/start-test-daemon';
import { waitFor } from '../test-utils/wait-for';
import { buildPayloadHash } from './build-payload-hash';
import type { DaemonOptions } from './daemon';

// The daemon options a test wires: the adapter, and the execution targets,
// which are the daemon's own local terminal when unset.
type IdempotencyTestConfig = Pick<DaemonOptions, 'adapter' | 'targets'>;

// A real daemon running the given adapter on the given targets.
function setupTest(config: IdempotencyTestConfig) {
  return startTestDaemon({ prefix: 'atc-idempotency-', options: () => config });
}

test('it answers a retried keyed spawn with the first session and spawns once', async () => {
  await using ctx = await setupTest({ adapter: buildMockAgentAdapter() });

  const params = { cwd: ctx.dir, cols: 80, rows: 24, idempotencyKey: 'k-1' };

  const first = await ctx.client.sendRequest('session.spawn', params);
  const second = await ctx.client.sendRequest('session.spawn', params);
  const list = await ctx.client.sendRequest('session.list');

  expect(second).toMatchObject({ session: { id: getRecord(first, 'session')['id'] } });
  expect(list['sessions']).toHaveLength(1);
});

test('it spawns once for two keyed spawns that arrive together', async () => {
  await using ctx = await setupTest({ adapter: buildMockAgentAdapter() });

  const params = { cwd: ctx.dir, cols: 80, rows: 24, idempotencyKey: 'k-1' };

  const [first, second] = await Promise.all([
    ctx.client.sendRequest('session.spawn', params),
    ctx.client.sendRequest('session.spawn', params),
  ]);

  const list = await ctx.client.sendRequest('session.list');

  expect(second).toMatchObject({ session: { id: getRecord(first, 'session')['id'] } });
  expect(list['sessions']).toHaveLength(1);
});

test('it replays a retried spawn whose params differ only in defaults and fields the daemon ignores', async () => {
  await using ctx = await setupTest({ adapter: buildMockAgentAdapter() });

  const first = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    idempotencyKey: 'k-1',
  });

  const second = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    cols: 80,
    rows: 24,
    name: '',
    unknown: true,
    idempotencyKey: 'k-1',
  });

  expect(second).toMatchObject({ session: { id: getRecord(first, 'session')['id'] } });
});

test('it refuses a key reused with a different spawn payload as idempotency_conflict', async () => {
  await using ctx = await setupTest({ adapter: buildMockAgentAdapter() });

  await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    cols: 80,
    rows: 24,
    idempotencyKey: 'k-1',
  });

  expect(
    ctx.client.sendRequest('session.spawn', {
      cwd: join(ctx.dir, 'other'),
      cols: 80,
      rows: 24,
      idempotencyKey: 'k-1',
    }),
  ).rejects.toMatchObject({ code: 'idempotency_conflict' });
});

test('it answers a spawn retried after an interrupted run with outcome_unknown and spawns nothing', async () => {
  await using ctx = await setupTest({ adapter: buildMockAgentAdapter() });

  const params = { cwd: ctx.dir, cols: 80, rows: 24, idempotencyKey: 'k-1' };

  await ctx.stop();

  const seed = await StateStore.open(ctx.dbPath);

  await seed.claimIdempotencyKey({
    principal: 'local',
    operation: 'session.spawn',
    key: 'k-1',
    payloadHash: buildPayloadHash(REQUEST_PARAM_SCHEMAS['session.spawn'].parse(params)),
    effectRef: 'never-spawned',
    at: Date.now(),
  });

  await seed.stop();
  await ctx.restart();

  const spawned = ctx.client.sendRequest('session.spawn', params);

  await Promise.allSettled([spawned]);

  const list = await ctx.client.sendRequest('session.list');

  expect(spawned).rejects.toMatchObject({
    code: 'outcome_unknown',
    data: { effectRef: 'never-spawned' },
  });

  expect(list['sessions']).toStrictEqual([]);
});

test('it refuses a spawn retried after an interrupted run whose session reached the fleet until the fleet is restored', async () => {
  await using ctx = await setupTest({ adapter: buildMockAgentAdapter() });

  const params = { cwd: ctx.dir, cols: 80, rows: 24, idempotencyKey: 'k-1' };

  await ctx.stop();

  const seed = await StateStore.open(ctx.dbPath);

  await seed.claimIdempotencyKey({
    principal: 'local',
    operation: 'session.spawn',
    key: 'k-1',
    payloadHash: buildPayloadHash(REQUEST_PARAM_SCHEMAS['session.spawn'].parse(params)),
    effectRef: 'spawned-before-crash',
    at: Date.now(),
  });

  await seed.writeFleet([
    {
      sessionID: toSessionID('spawned-before-crash'),
      name: 'work',
      cwd: ctx.dir,
      agent: 'claude',
      exited: true,
    },
  ]);

  await seed.stop();
  await ctx.restart();

  expect(ctx.client.sendRequest('session.spawn', params)).rejects.toMatchObject({
    code: 'no_such_session',
    data: { effectRef: 'spawned-before-crash' },
  });
});

test('it completes an interrupted spawn whose session reached the fleet and replays it once restored', async () => {
  await using ctx = await setupTest({ adapter: buildMockAgentAdapter() });

  const params = { cwd: ctx.dir, cols: 80, rows: 24, idempotencyKey: 'k-1' };

  await ctx.stop();

  const seed = await StateStore.open(ctx.dbPath);

  await seed.claimIdempotencyKey({
    principal: 'local',
    operation: 'session.spawn',
    key: 'k-1',
    payloadHash: buildPayloadHash(REQUEST_PARAM_SCHEMAS['session.spawn'].parse(params)),
    effectRef: 'spawned-before-crash',
    at: Date.now(),
  });

  await seed.writeFleet([
    {
      sessionID: toSessionID('spawned-before-crash'),
      name: 'work',
      cwd: ctx.dir,
      agent: 'claude',
      exited: true,
    },
  ]);

  await seed.stop();
  await ctx.restart();
  await Promise.allSettled([ctx.client.sendRequest('session.spawn', params)]);
  await ctx.client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const replayed = await ctx.client.sendRequest('session.spawn', params);
  const list = await ctx.client.sendRequest('session.list');

  expect(replayed).toMatchObject({ session: { id: 'spawned-before-crash' } });
  expect(list['sessions']).toHaveLength(1);
});

test('it refuses a keyed spawn whose agent fails to start as internal', async () => {
  const planSpawn = mock<AgentAdapter['planSpawn']>(() => ({ bin: 'sleep', args: ['30'] }));

  planSpawn.mockImplementationOnce(() => {
    throw new Error('no binary');
  });

  await using ctx = await setupTest({ adapter: buildMockAgentAdapter({ planSpawn }) });

  expect(
    ctx.client.sendRequest('session.spawn', {
      cwd: ctx.dir,
      cols: 80,
      rows: 24,
      idempotencyKey: 'k-1',
    }),
  ).rejects.toMatchObject({ code: 'internal' });
});

test('it drops the claim of a spawn that failed to start so a retry spawns', async () => {
  const planSpawn = mock<AgentAdapter['planSpawn']>(() => ({ bin: 'sleep', args: ['30'] }));

  planSpawn.mockImplementationOnce(() => {
    throw new Error('no binary');
  });

  await using ctx = await setupTest({ adapter: buildMockAgentAdapter({ planSpawn }) });

  const params = { cwd: ctx.dir, cols: 80, rows: 24, idempotencyKey: 'k-1' };

  await Promise.allSettled([ctx.client.sendRequest('session.spawn', params)]);

  const retried = await ctx.client.sendRequest('session.spawn', params);

  expect(retried).toMatchObject({ session: { cwd: ctx.dir } });
});

test('it records no claim for a keyed spawn refused before it starts', async () => {
  await using ctx = await setupTest({ adapter: buildMockAgentAdapter() });

  const spawned = ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    parent: 'ghost',
    cols: 80,
    rows: 24,
    idempotencyKey: 'k-1',
  });

  await Promise.allSettled([spawned]);

  using db = new Database(ctx.dbPath, { readonly: true });

  const rows = db.query('SELECT key FROM idempotency').all();

  expect(spawned).rejects.toMatchObject({ code: 'no_such_session' });
  expect(rows).toStrictEqual([]);
});

test('it replays a completed keyed spawn even once its parent is gone', async () => {
  await using ctx = await setupTest({ adapter: buildMockAgentAdapter() });

  const parent = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    cols: 80,
    rows: 24,
  });

  const parentID = getRecord(parent, 'session')['id'];
  const params = { cwd: ctx.dir, parent: parentID, cols: 80, rows: 24, idempotencyKey: 'k-1' };

  const first = await ctx.client.sendRequest('session.spawn', params);

  await ctx.client.sendRequest('session.kill', { session: parentID });
  await ctx.client.sendRequest('session.kill', { session: parentID });

  const retried = await ctx.client.sendRequest('session.spawn', params);

  expect(retried).toMatchObject({ session: { id: getRecord(first, 'session')['id'] } });
});

test('it refuses a spawn with fractional rows as bad_args before any session starts', async () => {
  await using ctx = await setupTest({ adapter: buildMockAgentAdapter() });

  const spawned = ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    cols: 80,
    rows: 24.5,
    idempotencyKey: 'k-1',
  });

  await Promise.allSettled([spawned]);

  const list = await ctx.client.sendRequest('session.list');

  expect(spawned).rejects.toMatchObject({ code: 'bad_args' });
  expect(list['sessions']).toStrictEqual([]);
});

test('it refuses a keyed spawn that fails after its process starts as internal', async () => {
  const stub = buildStubFailingAgentAdapter({
    firstPlan: { bin: 'sleep', args: ['30'] },
    laterPlan: { bin: 'sleep', args: ['30'] },
    failedReads: 1,
    readyFile: null,
  });

  await using ctx = await setupTest({ adapter: stub.adapter });

  expect(
    ctx.client.sendRequest('session.spawn', {
      cwd: ctx.dir,
      cols: 80,
      rows: 24,
      idempotencyKey: 'k-1',
    }),
  ).rejects.toMatchObject({ code: 'internal' });
});

test('it leaves no session behind from a keyed spawn that fails after its process starts, so a retry spawns once', async () => {
  const stub = buildStubFailingAgentAdapter({
    firstPlan: { bin: 'sleep', args: ['30'] },
    laterPlan: { bin: 'sleep', args: ['30'] },
    failedReads: 1,
    readyFile: null,
  });

  await using ctx = await setupTest({ adapter: stub.adapter });

  const params = { cwd: ctx.dir, cols: 80, rows: 24, idempotencyKey: 'k-1' };

  await Promise.allSettled([ctx.client.sendRequest('session.spawn', params)]);

  const retried = await ctx.client.sendRequest('session.spawn', params);
  const list = await ctx.client.sendRequest('session.list');

  expect(stub.countPlans()).toBe(2);
  expect(list['sessions']).toStrictEqual([getRecord(retried, 'session')]);
});

test('it answers outcome_unknown with its claim when killing a failed spawn throws', async () => {
  const stub = buildStubFailingAgentAdapter({
    firstPlan: { bin: 'sleep', args: ['30'] },
    laterPlan: { bin: 'sleep', args: ['30'] },
    failedReads: 2,
    readyFile: null,
  });

  await using ctx = await setupTest({ adapter: stub.adapter });

  const spawned = ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    cols: 80,
    rows: 24,
    idempotencyKey: 'k-1',
  });

  await Promise.allSettled([spawned]);

  using db = new Database(ctx.dbPath, { readonly: true });

  const claim = db.query<{ effect_ref: string }, []>('SELECT effect_ref FROM idempotency').get();

  expect(spawned).rejects.toMatchObject({
    code: 'outcome_unknown',
    data: { effectRef: claim?.effect_ref },
  });
});

test('it keeps the key as outcome_unknown when killing a failed spawn throws, so a retry spawns nothing', async () => {
  const stub = buildStubFailingAgentAdapter({
    firstPlan: { bin: 'sleep', args: ['30'] },
    laterPlan: { bin: 'sleep', args: ['30'] },
    failedReads: 2,
    readyFile: null,
  });

  await using ctx = await setupTest({ adapter: stub.adapter });

  const params = { cwd: ctx.dir, cols: 80, rows: 24, idempotencyKey: 'k-1' };

  await Promise.allSettled([ctx.client.sendRequest('session.spawn', params)]);

  using db = new Database(ctx.dbPath, { readonly: true });

  const claim = db.query<{ effect_ref: string }, []>('SELECT effect_ref FROM idempotency').get();
  const retried = ctx.client.sendRequest('session.spawn', params);

  await Promise.allSettled([retried]);

  const list = await ctx.client.sendRequest('session.list');

  expect(retried).rejects.toMatchObject({
    code: 'outcome_unknown',
    data: { effectRef: claim?.effect_ref },
  });

  expect(stub.countPlans()).toBe(1);
  expect(list['sessions']).not.toContainEqual(expect.objectContaining({ alive: true }));
});

test('it answers outcome_unknown when a failed spawn cannot be removed from the fleet', async () => {
  const stub = buildStubFailingAgentAdapter({
    firstPlan: { bin: 'sleep', args: ['30'] },
    laterPlan: { bin: 'sleep', args: ['30'] },
    failedReads: 1,
    readyFile: null,
  });

  await using ctx = await setupTest({ adapter: stub.adapter });

  // Another connection drops the fleet table, so no fleet write can land.
  {
    using db = new Database(ctx.dbPath);

    db.run('DROP TABLE fleet');
  }

  expect(
    ctx.client.sendRequest('session.spawn', {
      cwd: ctx.dir,
      cols: 80,
      rows: 24,
      idempotencyKey: 'k-1',
    }),
  ).rejects.toMatchObject({ code: 'outcome_unknown' });
});

test('it keeps the key as outcome_unknown when a failed spawn cannot be removed from the fleet, so a retry spawns nothing', async () => {
  const stub = buildStubFailingAgentAdapter({
    firstPlan: { bin: 'sleep', args: ['30'] },
    laterPlan: { bin: 'sleep', args: ['30'] },
    failedReads: 1,
    readyFile: null,
  });

  await using ctx = await setupTest({ adapter: stub.adapter });

  const params = { cwd: ctx.dir, cols: 80, rows: 24, idempotencyKey: 'k-1' };

  // Another connection drops the fleet table, so no fleet write can land.
  {
    using db = new Database(ctx.dbPath);

    db.run('DROP TABLE fleet');
  }

  await Promise.allSettled([ctx.client.sendRequest('session.spawn', params)]);

  const retried = ctx.client.sendRequest('session.spawn', params);

  await Promise.allSettled([retried]);

  const list = await ctx.client.sendRequest('session.list');

  expect(retried).rejects.toMatchObject({ code: 'outcome_unknown' });
  expect(stub.countPlans()).toBe(1);
  expect(list['sessions']).toStrictEqual([]);
});

test('it answers outcome_unknown with the session id when the fleet write after a successful spawn fails', async () => {
  await using ctx = await setupTest({ adapter: buildMockAgentAdapter() });

  // Another connection drops the fleet table, so the spawn starts but its
  // fleet write cannot land.
  using db = new Database(ctx.dbPath);

  db.run('DROP TABLE fleet');

  const spawned = ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    cols: 80,
    rows: 24,
    idempotencyKey: 'k-1',
  });

  await Promise.allSettled([spawned]);

  const list = await ctx.client.sendRequest('session.list');

  const claim = db.query<{ effect_ref: string }, []>('SELECT effect_ref FROM idempotency').get();

  expect(spawned).rejects.toMatchObject({
    code: 'outcome_unknown',
    data: { effectRef: claim?.effect_ref },
  });

  expect(list['sessions']).toStrictEqual([
    expect.objectContaining({ id: claim?.effect_ref, alive: true }),
  ]);
});

test('it keeps the key as outcome_unknown when the fleet write after a successful spawn fails, so a retry spawns nothing', async () => {
  const planSpawn = mock<AgentAdapter['planSpawn']>(() => ({ bin: 'sleep', args: ['30'] }));

  await using ctx = await setupTest({ adapter: buildMockAgentAdapter({ planSpawn }) });

  const params = { cwd: ctx.dir, cols: 80, rows: 24, idempotencyKey: 'k-1' };

  // Another connection drops the fleet table, so the spawn starts but its
  // fleet write cannot land.
  using db = new Database(ctx.dbPath);

  db.run('DROP TABLE fleet');

  await Promise.allSettled([ctx.client.sendRequest('session.spawn', params)]);

  const ref = db.query<{ effect_ref: string }, []>('SELECT effect_ref FROM idempotency').get();
  const retried = ctx.client.sendRequest('session.spawn', params);

  await Promise.allSettled([retried]);

  const list = await ctx.client.sendRequest('session.list');

  const claims = db.query('SELECT state, effect_ref FROM idempotency').all();

  expect(retried).rejects.toMatchObject({
    code: 'outcome_unknown',
    data: { effectRef: ref?.effect_ref },
  });

  expect(planSpawn).toHaveBeenCalledOnce();

  expect(list['sessions']).toStrictEqual([
    expect.objectContaining({ id: ref?.effect_ref, alive: true }),
  ]);

  expect(claims).toStrictEqual([{ state: 'outcome_unknown', effect_ref: ref?.effect_ref }]);
});

test('it answers outcome_unknown with the session id when completing the key fails', async () => {
  await using ctx = await setupTest({ adapter: buildMockAgentAdapter() });

  // Another connection makes every update of a key fail, so the claim lands
  // but neither its completion nor its outcome can.
  using db = new Database(ctx.dbPath);

  db.run(
    "CREATE TRIGGER fail_key_update BEFORE UPDATE ON idempotency BEGIN SELECT RAISE(ABORT, 'injected key write failure'); END",
  );

  const spawned = ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    cols: 80,
    rows: 24,
    idempotencyKey: 'k-1',
  });

  await Promise.allSettled([spawned]);

  const list = await ctx.client.sendRequest('session.list');

  const claim = db.query<{ effect_ref: string }, []>('SELECT effect_ref FROM idempotency').get();

  expect(spawned).rejects.toMatchObject({
    code: 'outcome_unknown',
    data: { effectRef: claim?.effect_ref },
  });

  expect(list['sessions']).toStrictEqual([
    expect.objectContaining({ id: claim?.effect_ref, alive: true }),
  ]);
});

test('it keeps the key in progress when completing it fails, so a retry spawns nothing', async () => {
  const planSpawn = mock<AgentAdapter['planSpawn']>(() => ({ bin: 'sleep', args: ['30'] }));

  await using ctx = await setupTest({ adapter: buildMockAgentAdapter({ planSpawn }) });

  const params = { cwd: ctx.dir, cols: 80, rows: 24, idempotencyKey: 'k-1' };

  // Another connection makes every update of a key fail, so the claim lands
  // but neither its completion nor its outcome can.
  using db = new Database(ctx.dbPath);

  db.run(
    "CREATE TRIGGER fail_key_update BEFORE UPDATE ON idempotency BEGIN SELECT RAISE(ABORT, 'injected key write failure'); END",
  );

  await Promise.allSettled([ctx.client.sendRequest('session.spawn', params)]);

  const ref = db.query<{ effect_ref: string }, []>('SELECT effect_ref FROM idempotency').get();
  const retried = ctx.client.sendRequest('session.spawn', params);

  await Promise.allSettled([retried]);

  const list = await ctx.client.sendRequest('session.list');

  const claims = db.query('SELECT state, effect_ref FROM idempotency').all();

  expect(retried).rejects.toMatchObject({
    code: 'outcome_unknown',
    data: { effectRef: ref?.effect_ref },
  });

  expect(planSpawn).toHaveBeenCalledOnce();

  expect(list['sessions']).toStrictEqual([
    expect.objectContaining({ id: ref?.effect_ref, alive: true }),
  ]);

  expect(claims).toStrictEqual([{ state: 'in_progress', effect_ref: ref?.effect_ref }]);
});

test('it answers outcome_unknown with the session id when the fleet write and the key update both fail after a successful spawn', async () => {
  await using ctx = await setupTest({ adapter: buildMockAgentAdapter() });

  using db = new Database(ctx.dbPath);

  db.run('DROP TABLE fleet');

  db.run(
    "CREATE TRIGGER fail_key_update BEFORE UPDATE ON idempotency BEGIN SELECT RAISE(ABORT, 'injected key write failure'); END",
  );

  const spawned = ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    cols: 80,
    rows: 24,
    idempotencyKey: 'k-1',
  });

  await Promise.allSettled([spawned]);

  const list = await ctx.client.sendRequest('session.list');

  const claim = db.query<{ effect_ref: string }, []>('SELECT effect_ref FROM idempotency').get();

  expect(spawned).rejects.toMatchObject({
    code: 'outcome_unknown',
    data: { effectRef: claim?.effect_ref },
  });

  expect(list['sessions']).toStrictEqual([
    expect.objectContaining({ id: claim?.effect_ref, alive: true }),
  ]);
});

test('it keeps the key in progress when the fleet write and the key update both fail after a successful spawn, so a retry spawns nothing', async () => {
  const planSpawn = mock<AgentAdapter['planSpawn']>(() => ({ bin: 'sleep', args: ['30'] }));

  await using ctx = await setupTest({ adapter: buildMockAgentAdapter({ planSpawn }) });

  const params = { cwd: ctx.dir, cols: 80, rows: 24, idempotencyKey: 'k-1' };

  using db = new Database(ctx.dbPath);

  db.run('DROP TABLE fleet');

  db.run(
    "CREATE TRIGGER fail_key_update BEFORE UPDATE ON idempotency BEGIN SELECT RAISE(ABORT, 'injected key write failure'); END",
  );

  await Promise.allSettled([ctx.client.sendRequest('session.spawn', params)]);

  const ref = db.query<{ effect_ref: string }, []>('SELECT effect_ref FROM idempotency').get();
  const retried = ctx.client.sendRequest('session.spawn', params);

  await Promise.allSettled([retried]);

  const list = await ctx.client.sendRequest('session.list');

  const claims = db.query('SELECT state, effect_ref FROM idempotency').all();

  expect(retried).rejects.toMatchObject({
    code: 'outcome_unknown',
    data: { effectRef: ref?.effect_ref },
  });

  expect(planSpawn).toHaveBeenCalledOnce();

  expect(list['sessions']).toStrictEqual([
    expect.objectContaining({ id: ref?.effect_ref, alive: true }),
  ]);

  expect(claims).toStrictEqual([{ state: 'in_progress', effect_ref: ref?.effect_ref }]);
});

test('it answers outcome_unknown with its claim when a failed spawn cannot leave the fleet and the key update fails too', async () => {
  const stub = buildStubFailingAgentAdapter({
    firstPlan: { bin: 'sleep', args: ['30'] },
    laterPlan: { bin: 'sleep', args: ['30'] },
    failedReads: 1,
    readyFile: null,
  });

  await using ctx = await setupTest({ adapter: stub.adapter });

  using db = new Database(ctx.dbPath);

  db.run('DROP TABLE fleet');

  db.run(
    "CREATE TRIGGER fail_key_update BEFORE UPDATE ON idempotency BEGIN SELECT RAISE(ABORT, 'injected key write failure'); END",
  );

  const spawned = ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    cols: 80,
    rows: 24,
    idempotencyKey: 'k-1',
  });

  await Promise.allSettled([spawned]);

  const claim = db.query<{ effect_ref: string }, []>('SELECT effect_ref FROM idempotency').get();

  expect(spawned).rejects.toMatchObject({
    code: 'outcome_unknown',
    data: { effectRef: claim?.effect_ref },
  });
});

test('it keeps the key in progress when a failed spawn cannot leave the fleet and the key update fails too, so a retry spawns nothing', async () => {
  const stub = buildStubFailingAgentAdapter({
    firstPlan: { bin: 'sleep', args: ['30'] },
    laterPlan: { bin: 'sleep', args: ['30'] },
    failedReads: 1,
    readyFile: null,
  });

  await using ctx = await setupTest({ adapter: stub.adapter });

  const params = { cwd: ctx.dir, cols: 80, rows: 24, idempotencyKey: 'k-1' };

  using db = new Database(ctx.dbPath);

  db.run('DROP TABLE fleet');

  db.run(
    "CREATE TRIGGER fail_key_update BEFORE UPDATE ON idempotency BEGIN SELECT RAISE(ABORT, 'injected key write failure'); END",
  );

  await Promise.allSettled([ctx.client.sendRequest('session.spawn', params)]);

  const ref = db.query<{ effect_ref: string }, []>('SELECT effect_ref FROM idempotency').get();
  const retried = ctx.client.sendRequest('session.spawn', params);

  await Promise.allSettled([retried]);

  const claims = db.query('SELECT state, effect_ref FROM idempotency').all();

  expect(retried).rejects.toMatchObject({
    code: 'outcome_unknown',
    data: { effectRef: ref?.effect_ref },
  });

  expect(stub.countPlans()).toBe(1);
  expect(claims).toStrictEqual([{ state: 'in_progress', effect_ref: ref?.effect_ref }]);
});

test('it ends a failed spawn that ignores its kill with a forced kill before it answers', async () => {
  using pids = setupTempDir('atc-idempotency-pid-');

  const pidPath = join(pids.dir, 'child.pid');

  // The child ignores SIGHUP before it writes its pid, and the start fails
  // only once that pid is written.
  const stub = buildStubFailingAgentAdapter({
    firstPlan: {
      bin: 'bash',
      args: [
        '-c',
        `trap '' HUP; echo $$ > '${pidPath}.tmp'; mv '${pidPath}.tmp' '${pidPath}'; exec sleep 10`,
      ],
    },
    laterPlan: { bin: 'sleep', args: ['30'] },
    failedReads: 1,
    readyFile: pidPath,
  });

  await using ctx = await setupTest({ adapter: stub.adapter });

  const spawned = ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    cols: 80,
    rows: 24,
    idempotencyKey: 'k-1',
  });

  await Promise.allSettled([spawned]);

  const pid = Number(readFileSync(pidPath, 'utf8'));

  expect(spawned).rejects.toMatchObject({ code: 'internal' });
  expect(() => process.kill(pid, 0)).toThrowWithMessage(Error, /ESRCH/);
});

test('it completes the rollback of a failed spawn that ignores its kill, so a retry spawns once', async () => {
  using pids = setupTempDir('atc-idempotency-pid-');

  const pidPath = join(pids.dir, 'child.pid');

  // The child ignores SIGHUP before it writes its pid, and the start fails
  // only once that pid is written.
  const stub = buildStubFailingAgentAdapter({
    firstPlan: {
      bin: 'bash',
      args: [
        '-c',
        `trap '' HUP; echo $$ > '${pidPath}.tmp'; mv '${pidPath}.tmp' '${pidPath}'; exec sleep 10`,
      ],
    },
    laterPlan: { bin: 'sleep', args: ['30'] },
    failedReads: 1,
    readyFile: pidPath,
  });

  await using ctx = await setupTest({ adapter: stub.adapter });

  const params = { cwd: ctx.dir, cols: 80, rows: 24, idempotencyKey: 'k-1' };

  await Promise.allSettled([ctx.client.sendRequest('session.spawn', params)]);

  const retried = await ctx.client.sendRequest('session.spawn', params);
  const list = await ctx.client.sendRequest('session.list');

  expect(stub.countPlans()).toBe(2);
  expect(list['sessions']).toStrictEqual([getRecord(retried, 'session')]);
});

test('it answers outcome_unknown and keeps the process of a failed spawn whose provider cannot confirm the exit', async () => {
  using pids = setupTempDir('atc-idempotency-pid-');

  const pidPath = join(pids.dir, 'child.pid');

  // The child ignores SIGHUP before it writes its pid, and the start fails
  // only once that pid is written, so the rollback's kill cannot end it.
  const stub = buildStubFailingAgentAdapter({
    firstPlan: {
      bin: 'bash',
      args: [
        '-c',
        `trap '' HUP; echo $$ > '${pidPath}.tmp'; mv '${pidPath}.tmp' '${pidPath}'; exec sleep 10`,
      ],
    },
    laterPlan: { bin: 'sleep', args: ['30'] },
    failedReads: 1,
    readyFile: pidPath,
  });

  await using ctx = await setupTest({
    adapter: stub.adapter,
    targets: [
      {
        id: 'local',
        kind: 'no-forced-kill',
        options: {},
        identity: 'test:local',
        provider: buildStubSoftKillProvider(),
      },
    ],
  });

  const spawned = ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    cols: 80,
    rows: 24,
    resume: 'agent-session-1',
    idempotencyKey: 'k-1',
  });

  await Promise.allSettled([spawned]);

  const pid = Number(readFileSync(pidPath, 'utf8'));

  onTestFinished(() => {
    process.kill(pid, 'SIGKILL');
  });

  using db = new Database(ctx.dbPath, { readonly: true });

  const claim = db.query<{ effect_ref: string }, []>('SELECT effect_ref FROM idempotency').get();

  expect(spawned).rejects.toMatchObject({
    code: 'outcome_unknown',
    data: { effectRef: claim?.effect_ref },
  });

  expect(process.kill(pid, 0)).toBeTrue();
});

test('it keeps the key of a failed spawn whose provider cannot confirm the exit as outcome_unknown, so a retry spawns nothing', async () => {
  using pids = setupTempDir('atc-idempotency-pid-');

  const pidPath = join(pids.dir, 'child.pid');

  // The child ignores SIGHUP before it writes its pid, and the start fails
  // only once that pid is written, so the rollback's kill cannot end it.
  const stub = buildStubFailingAgentAdapter({
    firstPlan: {
      bin: 'bash',
      args: [
        '-c',
        `trap '' HUP; echo $$ > '${pidPath}.tmp'; mv '${pidPath}.tmp' '${pidPath}'; exec sleep 10`,
      ],
    },
    laterPlan: { bin: 'sleep', args: ['30'] },
    failedReads: 1,
    readyFile: pidPath,
  });

  await using ctx = await setupTest({
    adapter: stub.adapter,
    targets: [
      {
        id: 'local',
        kind: 'no-forced-kill',
        options: {},
        identity: 'test:local',
        provider: buildStubSoftKillProvider(),
      },
    ],
  });

  const params = {
    cwd: ctx.dir,
    cols: 80,
    rows: 24,
    resume: 'agent-session-1',
    idempotencyKey: 'k-1',
  };

  await Promise.allSettled([ctx.client.sendRequest('session.spawn', params)]);

  const pid = Number(readFileSync(pidPath, 'utf8'));

  onTestFinished(() => {
    process.kill(pid, 'SIGKILL');
  });

  using db = new Database(ctx.dbPath, { readonly: true });

  const claim = db.query<{ effect_ref: string }, []>('SELECT effect_ref FROM idempotency').get();
  const retried = ctx.client.sendRequest('session.spawn', params);

  expect(retried).rejects.toMatchObject({
    code: 'outcome_unknown',
    data: { effectRef: claim?.effect_ref },
  });

  expect(stub.countPlans()).toBe(1);
});

test('it keeps a failed spawn whose provider cannot confirm the exit listed and refuses its revive', async () => {
  using pids = setupTempDir('atc-idempotency-pid-');

  const pidPath = join(pids.dir, 'child.pid');

  // The child ignores SIGHUP before it writes its pid, and the start fails
  // only once that pid is written, so the rollback's kill cannot end it.
  const stub = buildStubFailingAgentAdapter({
    firstPlan: {
      bin: 'bash',
      args: [
        '-c',
        `trap '' HUP; echo $$ > '${pidPath}.tmp'; mv '${pidPath}.tmp' '${pidPath}'; exec sleep 10`,
      ],
    },
    laterPlan: { bin: 'sleep', args: ['30'] },
    failedReads: 1,
    readyFile: pidPath,
  });

  await using ctx = await setupTest({
    adapter: stub.adapter,
    targets: [
      {
        id: 'local',
        kind: 'no-forced-kill',
        options: {},
        identity: 'test:local',
        provider: buildStubSoftKillProvider(),
      },
    ],
  });

  await Promise.allSettled([
    ctx.client.sendRequest('session.spawn', {
      cwd: ctx.dir,
      cols: 80,
      rows: 24,
      resume: 'agent-session-1',
      idempotencyKey: 'k-1',
    }),
  ]);

  const pid = Number(readFileSync(pidPath, 'utf8'));

  onTestFinished(() => {
    process.kill(pid, 'SIGKILL');
  });

  using db = new Database(ctx.dbPath, { readonly: true });

  const claim = db.query<{ effect_ref: string }, []>('SELECT effect_ref FROM idempotency').get();

  const adopted = ctx.client.sendRequest('session.adopt', {
    session: claim?.effect_ref,
    cols: 80,
    rows: 24,
  });

  await Promise.allSettled([adopted]);

  const list = await ctx.client.sendRequest('session.list');

  expect(adopted).rejects.toMatchObject({ code: 'no_such_session' });
  expect(list['sessions']).toStrictEqual([expect.objectContaining({ id: claim?.effect_ref })]);
});

test('it answers a failed spawn only once its killed process has exited', async () => {
  using pids = setupTempDir('atc-idempotency-pid-');

  const pidPath = join(pids.dir, 'child.pid');

  // The child takes 300ms to exit after SIGHUP, and the start fails only
  // once it has set that trap and written its pid.
  const stub = buildStubFailingAgentAdapter({
    firstPlan: {
      bin: 'bash',
      args: [
        '-c',
        `trap 'sleep 0.3; exit 0' HUP; echo $$ > '${pidPath}.tmp'; mv '${pidPath}.tmp' '${pidPath}'; while :; do sleep 0.05; done`,
      ],
    },
    laterPlan: { bin: 'sleep', args: ['30'] },
    failedReads: 1,
    readyFile: pidPath,
  });

  await using ctx = await setupTest({ adapter: stub.adapter });

  const spawned = ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    cols: 80,
    rows: 24,
    idempotencyKey: 'k-1',
  });

  await Promise.allSettled([spawned]);

  const pid = Number(readFileSync(pidPath, 'utf8'));

  expect(spawned).rejects.toMatchObject({ code: 'internal' });
  expect(() => process.kill(pid, 0)).toThrowWithMessage(Error, /ESRCH/);
});

test('it lets a retry spawn once after a failed spawn whose killed process took time to exit', async () => {
  using pids = setupTempDir('atc-idempotency-pid-');

  const pidPath = join(pids.dir, 'child.pid');

  // The child takes 300ms to exit after SIGHUP, and the start fails only
  // once it has set that trap and written its pid.
  const stub = buildStubFailingAgentAdapter({
    firstPlan: {
      bin: 'bash',
      args: [
        '-c',
        `trap 'sleep 0.3; exit 0' HUP; echo $$ > '${pidPath}.tmp'; mv '${pidPath}.tmp' '${pidPath}'; while :; do sleep 0.05; done`,
      ],
    },
    laterPlan: { bin: 'sleep', args: ['30'] },
    failedReads: 1,
    readyFile: pidPath,
  });

  await using ctx = await setupTest({ adapter: stub.adapter });

  const params = { cwd: ctx.dir, cols: 80, rows: 24, idempotencyKey: 'k-1' };

  await Promise.allSettled([ctx.client.sendRequest('session.spawn', params)]);

  const retried = await ctx.client.sendRequest('session.spawn', params);
  const list = await ctx.client.sendRequest('session.list');

  expect(stub.countPlans()).toBe(2);
  expect(list['sessions']).toStrictEqual([getRecord(retried, 'session')]);
});

test('it refuses to revive a failed spawn while its rollback waits for the killed process', async () => {
  using pids = setupTempDir('atc-idempotency-pid-');

  const pidPath = join(pids.dir, 'child.pid');

  // The child takes 300ms to exit after SIGHUP, and the start fails only
  // once it has set that trap and written its pid.
  const stub = buildStubFailingAgentAdapter({
    firstPlan: {
      bin: 'bash',
      args: [
        '-c',
        `trap 'sleep 0.3; exit 0' HUP; echo $$ > '${pidPath}.tmp'; mv '${pidPath}.tmp' '${pidPath}'; while :; do sleep 0.05; done`,
      ],
    },
    laterPlan: { bin: 'sleep', args: ['30'] },
    failedReads: 1,
    readyFile: pidPath,
  });

  await using ctx = await setupTest({ adapter: stub.adapter });

  const spawned = ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    cols: 80,
    rows: 24,
    resume: 'agent-session-1',
    idempotencyKey: 'k-1',
  });

  const listed = await waitFor(async () => {
    const list = await ctx.client.sendRequest('session.list');

    expect(list['sessions']).toHaveLength(1);

    return list;
  });

  const id = getRecord(getRecord(listed, 'sessions'), '0')['id'];

  const adopted = ctx.client.sendRequest('session.adopt', {
    session: id,
    cols: 80,
    rows: 24,
  });

  await Promise.allSettled([adopted, spawned]);

  expect(adopted).rejects.toMatchObject({ code: 'no_such_session' });
});

test('it leaves no session behind from a failed spawn whose revive was refused during its rollback', async () => {
  using pids = setupTempDir('atc-idempotency-pid-');

  const pidPath = join(pids.dir, 'child.pid');

  // The child takes 300ms to exit after SIGHUP, and the start fails only
  // once it has set that trap and written its pid.
  const stub = buildStubFailingAgentAdapter({
    firstPlan: {
      bin: 'bash',
      args: [
        '-c',
        `trap 'sleep 0.3; exit 0' HUP; echo $$ > '${pidPath}.tmp'; mv '${pidPath}.tmp' '${pidPath}'; while :; do sleep 0.05; done`,
      ],
    },
    laterPlan: { bin: 'sleep', args: ['30'] },
    failedReads: 1,
    readyFile: pidPath,
  });

  await using ctx = await setupTest({ adapter: stub.adapter });

  const spawned = ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    cols: 80,
    rows: 24,
    resume: 'agent-session-1',
    idempotencyKey: 'k-1',
  });

  const listed = await waitFor(async () => {
    const list = await ctx.client.sendRequest('session.list');

    expect(list['sessions']).toHaveLength(1);

    return list;
  });

  const id = getRecord(getRecord(listed, 'sessions'), '0')['id'];

  await Promise.allSettled([
    ctx.client.sendRequest('session.adopt', {
      session: id,
      cols: 80,
      rows: 24,
    }),
  ]);

  await Promise.allSettled([spawned]);

  const list = await ctx.client.sendRequest('session.list');

  expect(spawned).rejects.toMatchObject({ code: 'internal' });
  expect(stub.countPlans()).toBe(1);
  expect(list['sessions']).toStrictEqual([]);
});

test('it answers a retried keyed message with the first message and sends once', async () => {
  await using ctx = await setupTest({ adapter: buildMockAgentAdapter({ takesMessages: true }) });

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    cols: 80,
    rows: 24,
  });

  const params = {
    session: getRecord(spawned, 'session')['id'],
    text: 'hello',
    idempotencyKey: 'm-key',
  };

  const first = await ctx.client.sendRequest('session.message', params);
  const second = await ctx.client.sendRequest('session.message', params);

  using db = new Database(ctx.dbPath, { readonly: true });

  const rows = db.query('SELECT id FROM messages').all();

  expect(second).toStrictEqual({ message: first['message'], status: 'accepted' });
  expect(rows).toStrictEqual([{ id: first['message'] }]);
});

test('it replays a retried message whose params differ only in a default and a field the daemon ignores', async () => {
  await using ctx = await setupTest({ adapter: buildMockAgentAdapter({ takesMessages: true }) });

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    cols: 80,
    rows: 24,
  });

  const session = getRecord(spawned, 'session')['id'];

  const first = await ctx.client.sendRequest('session.message', {
    session,
    text: 'hello',
    idempotencyKey: 'm-key',
  });

  const second = await ctx.client.sendRequest('session.message', {
    session,
    text: 'hello',
    from: 'unknown',
    unknown: true,
    idempotencyKey: 'm-key',
  });

  expect(second).toStrictEqual({ message: first['message'], status: 'accepted' });
});

test('it refuses a message key reused with different text as idempotency_conflict', async () => {
  await using ctx = await setupTest({ adapter: buildMockAgentAdapter({ takesMessages: true }) });

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    cols: 80,
    rows: 24,
  });

  const session = getRecord(spawned, 'session')['id'];

  await ctx.client.sendRequest('session.message', {
    session,
    text: 'one',
    idempotencyKey: 'm-key',
  });

  expect(
    ctx.client.sendRequest('session.message', { session, text: 'two', idempotencyKey: 'm-key' }),
  ).rejects.toMatchObject({ code: 'idempotency_conflict' });
});

test('it drops the claim of a keyed message its session refuses', async () => {
  await using ctx = await setupTest({ adapter: buildMockAgentAdapter({ takesMessages: true }) });

  const sent = ctx.client.sendRequest('session.message', {
    session: 'ghost',
    text: 'hello',
    idempotencyKey: 'm-key',
  });

  await Promise.allSettled([sent]);

  using db = new Database(ctx.dbPath, { readonly: true });

  const rows = db.query('SELECT key FROM idempotency').all();

  expect(sent).rejects.toMatchObject({ code: 'no_such_session' });
  expect(rows).toStrictEqual([]);
});

test('it completes an interrupted message whose row was written and replays it', async () => {
  await using ctx = await setupTest({ adapter: buildMockAgentAdapter({ takesMessages: true }) });

  const params = { session: 's-gone', text: 'hello', idempotencyKey: 'm-key' };

  await ctx.stop();

  const seed = await StateStore.open(ctx.dbPath);

  await seed.claimIdempotencyKey({
    principal: 'local',
    operation: 'session.message',
    key: 'm-key',
    payloadHash: buildPayloadHash(REQUEST_PARAM_SCHEMAS['session.message'].parse(params)),
    effectRef: 'm-written',
    at: Date.now(),
  });

  await seed.writeMessage({
    id: toMessageID('m-written'),
    atcID: toSessionID('s-gone'),
    from: 'unknown',
    text: 'hello',
    status: 'accepted',
    sentAt: Date.now(),
  });

  await seed.stop();
  await ctx.restart();

  const replayed = await ctx.client.sendRequest('session.message', params);

  expect(replayed).toStrictEqual({ message: 'm-written', status: 'accepted' });
});

test('it answers a message retried after an interrupted send with outcome_unknown', async () => {
  await using ctx = await setupTest({ adapter: buildMockAgentAdapter({ takesMessages: true }) });

  const params = { session: 's-gone', text: 'hello', idempotencyKey: 'm-key' };

  await ctx.stop();

  const seed = await StateStore.open(ctx.dbPath);

  await seed.claimIdempotencyKey({
    principal: 'local',
    operation: 'session.message',
    key: 'm-key',
    payloadHash: buildPayloadHash(REQUEST_PARAM_SCHEMAS['session.message'].parse(params)),
    effectRef: 'm-never-written',
    at: Date.now(),
  });

  await seed.stop();
  await ctx.restart();

  expect(ctx.client.sendRequest('session.message', params)).rejects.toMatchObject({
    code: 'outcome_unknown',
    data: { effectRef: 'm-never-written' },
  });
});

test('it refuses a replay-only spawn whose key it never held as idempotency_key_unknown and spawns nothing', async () => {
  await using ctx = await setupTest({ adapter: buildMockAgentAdapter() });

  const refused = ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    cols: 80,
    rows: 24,
    idempotencyKey: 'never-held',
    replayOnly: true,
  });

  await Promise.allSettled([refused]);

  const list = await ctx.client.sendRequest('session.list');

  expect(refused).rejects.toMatchObject({ code: 'idempotency_key_unknown' });
  expect(list['sessions']).toStrictEqual([]);
});

test('it refuses a replay-only spawn whose completed key was swept and spawns nothing more', async () => {
  await using ctx = await setupTest({ adapter: buildMockAgentAdapter() });

  const params = { cwd: ctx.dir, cols: 80, rows: 24, idempotencyKey: 'swept' };

  await ctx.client.sendRequest('session.spawn', params);

  {
    using db = new Database(ctx.dbPath);

    db.run("DELETE FROM idempotency WHERE state = 'completed'");
  }

  const refused = ctx.client.sendRequest('session.spawn', { ...params, replayOnly: true });

  await Promise.allSettled([refused]);

  const list = await ctx.client.sendRequest('session.list');

  expect(refused).rejects.toMatchObject({ code: 'idempotency_key_unknown' });
  expect(list['sessions']).toHaveLength(1);
});

test('it replays a held key for a replay-only spawn and spawns nothing more', async () => {
  await using ctx = await setupTest({ adapter: buildMockAgentAdapter() });

  const params = { cwd: ctx.dir, cols: 80, rows: 24, idempotencyKey: 'held' };

  const first = await ctx.client.sendRequest('session.spawn', params);
  const replayed = await ctx.client.sendRequest('session.spawn', { ...params, replayOnly: true });
  const list = await ctx.client.sendRequest('session.list');

  expect(replayed).toMatchObject({ session: { id: getRecord(first, 'session')['id'] } });
  expect(list['sessions']).toHaveLength(1);
});

test('it replays a held key for a replay-only message', async () => {
  await using ctx = await setupTest({ adapter: buildMockAgentAdapter({ takesMessages: true }) });

  const spawned = await ctx.client.sendRequest('session.spawn', {
    cwd: ctx.dir,
    cols: 80,
    rows: 24,
  });

  const params = {
    session: getRecord(spawned, 'session')['id'],
    text: 'hello',
    idempotencyKey: 'held-message',
  };

  const sent = await ctx.client.sendRequest('session.message', params);
  const resent = await ctx.client.sendRequest('session.message', { ...params, replayOnly: true });

  expect(resent).toStrictEqual(sent);
});

test('it refuses a replay-only spawn without an idempotency key as bad_args and spawns nothing', async () => {
  await using ctx = await setupTest({ adapter: buildMockAgentAdapter() });

  const refused = ctx.client.sendRequest('session.spawn', { cwd: ctx.dir, replayOnly: true });

  await Promise.allSettled([refused]);

  const list = await ctx.client.sendRequest('session.list');

  expect(refused).rejects.toMatchObject({ code: 'bad_args' });
  expect(list['sessions']).toStrictEqual([]);
});
