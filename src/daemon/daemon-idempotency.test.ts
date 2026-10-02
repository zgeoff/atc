import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentAdapter } from '../agents/agent-adapter';
import { DaemonClient } from '../client/daemon-client';
import { REQUEST_PARAM_SCHEMAS } from '../protocol/request-param-schemas';
import { getRecord } from '../shared/get-record';
import { toMessageID } from '../shared/to-message-id';
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

test('it keeps the key as outcome_unknown when killing a failed spawn throws, so a retry spawns nothing', async () => {
  await using ctx = await setupTest();

  // The first spawn's process starts, then the next two reads of the adapter
  // throw: one fails the start, and one fails the kill that takes it back,
  // since the kill reports the exit as it ends the process.
  let throws = 0;
  let planned = 0;

  const failing: AgentAdapter = {
    ...idleAdapter,
    planSpawn: () => {
      planned++;

      if (planned === 1) {
        throws = 2;
      }

      return { bin: 'sleep', args: ['30'] };
    },
    get headlessRunner() {
      if (throws > 0) {
        throws--;
        throw new Error('adapter failed after the process started');
      }

      return null;
    },
  };

  const client = await ctx.boot(failing);

  const params = { cwd: '/tmp', cols: 80, rows: 24, idempotencyKey: 'k-1' };

  const first = await client.sendRequest('session.spawn', params).catch((error: unknown) => ({
    error,
  }));

  expect(first).toMatchObject({ error: { code: 'outcome_unknown' } });

  const effectRef = getRecord(getRecord(first, 'error'), 'data')['effectRef'];

  expect(effectRef).toBeString();

  const retried = client.sendRequest('session.spawn', params);

  expect(retried).rejects.toMatchObject({ code: 'outcome_unknown', data: { effectRef } });

  await retried.catch(() => null);

  const list = await client.sendRequest('session.list');

  expect(planned).toBe(1);
  expect(list['sessions']).not.toContainEqual(expect.objectContaining({ alive: true }));
});

test('it keeps the key as outcome_unknown when a failed spawn cannot be removed from the fleet, so a retry spawns nothing', async () => {
  await using ctx = await setupTest();

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

  // Another connection drops the fleet table, so no fleet write can land.
  const db = new Database(ctx.dbPath);

  db.run('DROP TABLE fleet');
  db.close();

  const params = { cwd: '/tmp', cols: 80, rows: 24, idempotencyKey: 'k-1' };
  const first = client.sendRequest('session.spawn', params);

  expect(first).rejects.toMatchObject({ code: 'outcome_unknown' });

  await first.catch(() => null);

  const retried = client.sendRequest('session.spawn', params);

  expect(retried).rejects.toMatchObject({ code: 'outcome_unknown' });

  await retried.catch(() => null);

  const list = await client.sendRequest('session.list');

  expect(planned).toBe(1);
  expect(list['sessions']).toStrictEqual([]);
});

test('it answers a retried keyed message with the first message and sends once', async () => {
  await using ctx = await setupTest();

  const client = await ctx.boot({ ...idleAdapter, takesMessages: true });
  const spawned = await client.sendRequest('session.spawn', { cwd: '/tmp', cols: 80, rows: 24 });

  const session = getRecord(spawned, 'session')['id'];
  const params = { session, text: 'hello', idempotencyKey: 'm-key' };

  const first = await client.sendRequest('session.message', params);
  const second = await client.sendRequest('session.message', params);

  const db = new Database(ctx.dbPath, { readonly: true });

  const rows = db.query('SELECT id FROM messages').all();

  db.close();

  expect(second).toStrictEqual({ message: first['message'], status: 'accepted' });
  expect(rows).toStrictEqual([{ id: first['message'] }]);
});

test('it replays a retried message whose params differ only in a default and a field the daemon ignores', async () => {
  await using ctx = await setupTest();

  const client = await ctx.boot({ ...idleAdapter, takesMessages: true });
  const spawned = await client.sendRequest('session.spawn', { cwd: '/tmp', cols: 80, rows: 24 });

  const session = getRecord(spawned, 'session')['id'];

  const first = await client.sendRequest('session.message', {
    session,
    text: 'hello',
    idempotencyKey: 'm-key',
  });

  const second = await client.sendRequest('session.message', {
    session,
    text: 'hello',
    from: 'unknown',
    unknown: true,
    idempotencyKey: 'm-key',
  });

  expect(second).toStrictEqual({ message: first['message'], status: 'accepted' });
});

test('it refuses a message key reused with different text as idempotency_conflict', async () => {
  await using ctx = await setupTest();

  const client = await ctx.boot({ ...idleAdapter, takesMessages: true });
  const spawned = await client.sendRequest('session.spawn', { cwd: '/tmp', cols: 80, rows: 24 });

  const session = getRecord(spawned, 'session')['id'];

  await client.sendRequest('session.message', { session, text: 'one', idempotencyKey: 'm-key' });

  expect(
    client.sendRequest('session.message', { session, text: 'two', idempotencyKey: 'm-key' }),
  ).rejects.toMatchObject({ code: 'idempotency_conflict' });
});

test('it drops the claim of a keyed message its session refuses', async () => {
  await using ctx = await setupTest();

  const client = await ctx.boot({ ...idleAdapter, takesMessages: true });

  expect(
    client.sendRequest('session.message', {
      session: 'ghost',
      text: 'hello',
      idempotencyKey: 'm-key',
    }),
  ).rejects.toMatchObject({ code: 'no_such_session' });

  await client.sendRequest('session.list');

  const db = new Database(ctx.dbPath, { readonly: true });

  const rows = db.query('SELECT key FROM idempotency').all();

  db.close();

  expect(rows).toStrictEqual([]);
});

test('it completes an interrupted message whose row was written and replays it', async () => {
  await using ctx = await setupTest();

  const params = { session: 's-gone', text: 'hello', idempotencyKey: 'm-key' };

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

  const client = await ctx.boot({ ...idleAdapter, takesMessages: true });
  const replayed = await client.sendRequest('session.message', params);

  expect(replayed).toStrictEqual({ message: 'm-written', status: 'accepted' });
});

test('it answers a message retried after an interrupted send with outcome_unknown', async () => {
  await using ctx = await setupTest();

  const params = { session: 's-gone', text: 'hello', idempotencyKey: 'm-key' };

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

  const client = await ctx.boot({ ...idleAdapter, takesMessages: true });

  expect(client.sendRequest('session.message', params)).rejects.toMatchObject({
    code: 'outcome_unknown',
    data: { effectRef: 'm-never-written' },
  });
});
