import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentAdapter } from '../agents/agent-adapter';
import { DaemonClient } from '../client/daemon-client';
import { REQUEST_PARAM_SCHEMAS } from '../protocol/request-param-schemas';
import { getRecord } from '../shared/get-record';
import { toSessionID } from '../shared/to-session-id';
import { StateStore } from '../store/state-store';
import { buildPayloadHash } from './build-payload-hash';
import { startDaemon } from './daemon';
import type { DaemonHandle } from './daemon';

const idleAdapter: AgentAdapter = {
  id: 'claude',
  headlessRunner: null,
  screenDetector: null,
  takesMessages: false,
  planSpawn: () => ({ bin: 'sleep', args: ['30'] }),
  normalizeHook: () => ({ kind: 'heartbeat' }),
  loadName: () => Promise.resolve(null),
  canResume: () => true,
  buildResumeCommand: () => null,
};

// A temp state directory; the test seeds its store, then boots the daemon
// on it with the adapter it needs.
async function setupTest() {
  const dir = await mkdtemp(join(tmpdir(), 'atc-idempotency-'));

  const dbPath = join(dir, 'state.db');
  const socketPath = join(dir, 'daemon.sock');
  const daemons: DaemonHandle[] = [];
  const clients: DaemonClient[] = [];

  return {
    dbPath,
    async boot(adapter: AgentAdapter = idleAdapter) {
      const daemon = await startDaemon({
        socketPath,
        reporterSocketPath: join(dir, 'reporter.sock'),
        build: 'atc/test-build',
        adapter,
        dbPath,
        statusPath: join(dir, 'status.json'),
      });

      daemons.push(daemon);

      const client = await DaemonClient.open(socketPath);

      clients.push(client);

      await client.sendHello('atc/test-build');

      return client;
    },
    async [Symbol.asyncDispose]() {
      for (const client of clients) {
        client.stop();
      }

      for (const daemon of daemons) {
        await daemon.stop();
      }

      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('it answers a retried keyed spawn with the first session and spawns once', async () => {
  await using ctx = await setupTest();

  const client = await ctx.boot();

  const params = { cwd: '/tmp', cols: 80, rows: 24, idempotencyKey: 'k-1' };

  const first = await client.sendRequest('session.spawn', params);
  const second = await client.sendRequest('session.spawn', params);
  const list = await client.sendRequest('session.list');

  expect(second).toMatchObject({ session: { id: getRecord(first, 'session')['id'] } });
  expect(list['sessions']).toHaveLength(1);
});

test('it spawns once for two keyed spawns that arrive together', async () => {
  await using ctx = await setupTest();

  const client = await ctx.boot();

  const params = { cwd: '/tmp', cols: 80, rows: 24, idempotencyKey: 'k-1' };

  const [first, second] = await Promise.all([
    client.sendRequest('session.spawn', params),
    client.sendRequest('session.spawn', params),
  ]);

  const list = await client.sendRequest('session.list');

  expect(second).toMatchObject({ session: { id: getRecord(first, 'session')['id'] } });
  expect(list['sessions']).toHaveLength(1);
});

test('it replays a retried spawn whose params differ only in defaults and fields the daemon ignores', async () => {
  await using ctx = await setupTest();

  const client = await ctx.boot();
  const first = await client.sendRequest('session.spawn', { cwd: '/tmp', idempotencyKey: 'k-1' });

  const second = await client.sendRequest('session.spawn', {
    cwd: '/tmp',
    cols: 80,
    rows: 24,
    name: '',
    unknown: true,
    idempotencyKey: 'k-1',
  });

  expect(second).toMatchObject({ session: { id: getRecord(first, 'session')['id'] } });
});

test('it refuses a key reused with a different spawn payload as idempotency_conflict', async () => {
  await using ctx = await setupTest();

  const client = await ctx.boot();

  await client.sendRequest('session.spawn', {
    cwd: '/tmp',
    cols: 80,
    rows: 24,
    idempotencyKey: 'k-1',
  });

  expect(
    client.sendRequest('session.spawn', {
      cwd: '/var',
      cols: 80,
      rows: 24,
      idempotencyKey: 'k-1',
    }),
  ).rejects.toMatchObject({ code: 'idempotency_conflict' });
});

test('it answers a spawn retried after an interrupted run with outcome_unknown and spawns nothing', async () => {
  await using ctx = await setupTest();

  const params = { cwd: '/tmp', cols: 80, rows: 24, idempotencyKey: 'k-1' };

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

  const client = await ctx.boot();

  expect(client.sendRequest('session.spawn', params)).rejects.toMatchObject({
    code: 'outcome_unknown',
    data: { effectRef: 'never-spawned' },
  });

  const list = await client.sendRequest('session.list');

  expect(list['sessions']).toStrictEqual([]);
});

test('it completes an interrupted spawn whose session reached the fleet and replays it once restored', async () => {
  await using ctx = await setupTest();

  const params = { cwd: '/tmp', cols: 80, rows: 24, idempotencyKey: 'k-1' };

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
      name: 'tmp',
      cwd: '/tmp',
      agent: 'claude',
      exited: true,
    },
  ]);

  await seed.stop();

  const client = await ctx.boot();

  expect(client.sendRequest('session.spawn', params)).rejects.toMatchObject({
    code: 'no_such_session',
    data: { effectRef: 'spawned-before-crash' },
  });

  await client.sendRequest('fleet.restore', { cols: 80, rows: 24 });

  const replayed = await client.sendRequest('session.spawn', params);
  const list = await client.sendRequest('session.list');

  expect(replayed).toMatchObject({ session: { id: 'spawned-before-crash' } });
  expect(list['sessions']).toHaveLength(1);
});

test('it drops the claim of a spawn that failed to start so a retry spawns', async () => {
  await using ctx = await setupTest();

  let attempts = 0;

  const flaky: AgentAdapter = {
    ...idleAdapter,
    planSpawn: () => {
      attempts++;

      if (attempts === 1) {
        throw new Error('no binary');
      }

      return { bin: 'sleep', args: ['30'] };
    },
  };

  const client = await ctx.boot(flaky);

  const params = { cwd: '/tmp', cols: 80, rows: 24, idempotencyKey: 'k-1' };

  expect(client.sendRequest('session.spawn', params)).rejects.toMatchObject({ code: 'internal' });

  const retried = await client.sendRequest('session.spawn', params);

  expect(retried).toMatchObject({ session: { cwd: '/tmp' } });
});

test('it records no claim for a keyed spawn refused before it starts', async () => {
  await using ctx = await setupTest();

  const client = await ctx.boot();

  expect(
    client.sendRequest('session.spawn', {
      cwd: '/tmp',
      parent: 'ghost',
      cols: 80,
      rows: 24,
      idempotencyKey: 'k-1',
    }),
  ).rejects.toMatchObject({ code: 'no_such_session' });

  await client.sendRequest('session.list');

  const db = new Database(ctx.dbPath, { readonly: true });

  const rows = db.query('SELECT key FROM idempotency').all();

  db.close();

  expect(rows).toStrictEqual([]);
});

test('it replays a completed keyed spawn even once its parent is gone', async () => {
  await using ctx = await setupTest();

  const client = await ctx.boot();
  const parent = await client.sendRequest('session.spawn', { cwd: '/tmp', cols: 80, rows: 24 });

  const parentID = getRecord(parent, 'session')['id'];
  const params = { cwd: '/tmp', parent: parentID, cols: 80, rows: 24, idempotencyKey: 'k-1' };

  const first = await client.sendRequest('session.spawn', params);

  await client.sendRequest('session.kill', { session: parentID });
  await client.sendRequest('session.kill', { session: parentID });

  const retried = await client.sendRequest('session.spawn', params);

  expect(retried).toMatchObject({ session: { id: getRecord(first, 'session')['id'] } });
});

test('it refuses a spawn with fractional rows as bad_args before any session starts', async () => {
  await using ctx = await setupTest();

  const client = await ctx.boot();

  const spawn = client.sendRequest('session.spawn', {
    cwd: '/tmp',
    cols: 80,
    rows: 24.5,
    idempotencyKey: 'k-1',
  });

  expect(spawn).rejects.toMatchObject({ code: 'bad_args' });

  await spawn.catch(() => null);

  const list = await client.sendRequest('session.list');

  expect(list['sessions']).toStrictEqual([]);
});

test('it leaves no session behind from a keyed spawn that fails after its process starts, so a retry spawns once', async () => {
  await using ctx = await setupTest();

  // The first spawn's process starts, then the next read of the adapter
  // throws: a failure after the side effect, whatever the request held.
  let armed = false;
  let planned = 0;

  const failing: AgentAdapter = {
    ...idleAdapter,
    planSpawn: () => {
      planned++;
      armed = planned === 1;

      return { bin: 'sleep', args: ['30'] };
    },
    get headlessRunner() {
      if (armed) {
        armed = false;
        throw new Error('adapter failed after the process started');
      }

      return null;
    },
  };

  const client = await ctx.boot(failing);

  const params = { cwd: '/tmp', cols: 80, rows: 24, idempotencyKey: 'k-1' };
  const first = client.sendRequest('session.spawn', params);

  expect(first).rejects.toMatchObject({ code: 'internal' });

  await first.catch(() => null);

  const retried = await client.sendRequest('session.spawn', params);
  const list = await client.sendRequest('session.list');

  expect(planned).toBe(2);
  expect(list['sessions']).toStrictEqual([getRecord(retried, 'session')]);
});
