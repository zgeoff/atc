import { Database } from 'bun:sqlite';
import { expect, onTestFinished, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitFor } from '../../test/wait-for';
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
import type { ExecutionProvider, HarnessHandle } from './execution-provider';
import { LocalPTYProvider } from './local-pty-provider';

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
    dir,
    dbPath,
    async boot(adapter: AgentAdapter = idleAdapter, provider?: ExecutionProvider) {
      const daemon = await startDaemon({
        socketPath,
        reporterSocketPath: join(dir, 'reporter.sock'),
        build: 'atc/test-build',
        adapter,
        dbPath,
        statusPath: join(dir, 'status.json'),
        ...(provider === undefined
          ? {}
          : {
              targets: [
                { id: 'local', kind: provider.kind, options: {}, identity: 'test:local', provider },
              ],
            }),
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

test('it answers outcome_unknown with the session id when the fleet write after a successful spawn fails, so a retry spawns nothing', async () => {
  await using ctx = await setupTest();

  let planned = 0;

  const counting: AgentAdapter = {
    ...idleAdapter,
    planSpawn: () => {
      planned++;

      return { bin: 'sleep', args: ['30'] };
    },
  };

  const client = await ctx.boot(counting);

  // Another connection drops the fleet table, so the spawn starts but its
  // fleet write cannot land.
  const db = new Database(ctx.dbPath);

  db.run('DROP TABLE fleet');

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

  const claim = db.query('SELECT state, effect_ref FROM idempotency').all();

  db.close();

  expect(planned).toBe(1);
  expect(list['sessions']).toStrictEqual([expect.objectContaining({ id: effectRef, alive: true })]);
  expect(claim).toStrictEqual([{ state: 'outcome_unknown', effect_ref: effectRef }]);
});

test('it answers outcome_unknown with the session id when completing the key fails, so a retry spawns nothing', async () => {
  await using ctx = await setupTest();

  let planned = 0;

  const counting: AgentAdapter = {
    ...idleAdapter,
    planSpawn: () => {
      planned++;

      return { bin: 'sleep', args: ['30'] };
    },
  };

  const client = await ctx.boot(counting);

  // Another connection makes every update of a key fail, so the claim lands
  // but neither its completion nor its outcome can.
  const db = new Database(ctx.dbPath);

  db.run(
    "CREATE TRIGGER fail_key_update BEFORE UPDATE ON idempotency BEGIN SELECT RAISE(ABORT, 'injected key write failure'); END",
  );

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

  const claim = db.query('SELECT state, effect_ref FROM idempotency').all();

  db.close();

  expect(planned).toBe(1);
  expect(list['sessions']).toStrictEqual([expect.objectContaining({ id: effectRef, alive: true })]);
  expect(claim).toStrictEqual([{ state: 'in_progress', effect_ref: effectRef }]);
});

test('it answers outcome_unknown with the session id when the fleet write and the key update both fail after a successful spawn', async () => {
  await using ctx = await setupTest();

  let planned = 0;

  const counting: AgentAdapter = {
    ...idleAdapter,
    planSpawn: () => {
      planned++;

      return { bin: 'sleep', args: ['30'] };
    },
  };

  const client = await ctx.boot(counting);

  const db = new Database(ctx.dbPath);

  db.run('DROP TABLE fleet');

  db.run(
    "CREATE TRIGGER fail_key_update BEFORE UPDATE ON idempotency BEGIN SELECT RAISE(ABORT, 'injected key write failure'); END",
  );

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

  const claim = db.query('SELECT state, effect_ref FROM idempotency').all();

  db.close();

  expect(planned).toBe(1);
  expect(list['sessions']).toStrictEqual([expect.objectContaining({ id: effectRef, alive: true })]);
  expect(claim).toStrictEqual([{ state: 'in_progress', effect_ref: effectRef }]);
});

test('it answers outcome_unknown with the session id when a failed spawn cannot leave the fleet and the key update fails too', async () => {
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

  const db = new Database(ctx.dbPath);

  db.run('DROP TABLE fleet');

  db.run(
    "CREATE TRIGGER fail_key_update BEFORE UPDATE ON idempotency BEGIN SELECT RAISE(ABORT, 'injected key write failure'); END",
  );

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

  const claim = db.query('SELECT state, effect_ref FROM idempotency').all();

  db.close();

  expect(planned).toBe(1);
  expect(claim).toStrictEqual([{ state: 'in_progress', effect_ref: effectRef }]);
});

test('it ends a failed spawn that ignores its kill with a forced kill, so the rollback completes and a retry spawns once', async () => {
  await using ctx = await setupTest();

  const pidPath = join(ctx.dir, 'child.pid');
  let armed = false;
  let planned = 0;

  // The first child ignores SIGHUP before it writes its pid, and the start
  // fails only once that pid is written.
  const failing: AgentAdapter = {
    ...idleAdapter,
    planSpawn: () => {
      planned++;
      armed = planned === 1;

      return planned === 1
        ? {
            bin: 'bash',
            args: [
              '-c',
              `trap '' HUP; echo $$ > '${pidPath}.tmp'; mv '${pidPath}.tmp' '${pidPath}'; exec sleep 10`,
            ],
          }
        : { bin: 'sleep', args: ['30'] };
    },
    get headlessRunner() {
      if (armed) {
        armed = false;

        while (!existsSync(pidPath)) {
          Bun.sleepSync(10);
        }

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

  const pid = Number(readFileSync(pidPath, 'utf8'));

  expect(() => process.kill(pid, 0)).toThrow();

  const retried = await client.sendRequest('session.spawn', params);
  const list = await client.sendRequest('session.list');

  expect(planned).toBe(2);
  expect(list['sessions']).toStrictEqual([getRecord(retried, 'session')]);
}, 10_000);

test('it keeps a failed spawn listed, its key outcome_unknown, and its revive refused when its provider cannot confirm the exit', async () => {
  await using ctx = await setupTest();

  const pidPath = join(ctx.dir, 'child.pid');
  let armed = false;
  let planned = 0;

  // The child ignores SIGHUP before it writes its pid, and the start fails
  // only once that pid is written, so the rollback's kill cannot end it.
  const failing: AgentAdapter = {
    ...idleAdapter,
    planSpawn: () => {
      planned++;
      armed = planned === 1;

      return {
        bin: 'bash',
        args: [
          '-c',
          `trap '' HUP; echo $$ > '${pidPath}.tmp'; mv '${pidPath}.tmp' '${pidPath}'; exec sleep 10`,
        ],
      };
    },
    get headlessRunner() {
      if (armed) {
        armed = false;

        while (!existsSync(pidPath)) {
          Bun.sleepSync(10);
        }

        throw new Error('adapter failed after the process started');
      }

      return null;
    },
  };

  // A provider that runs harnesses on local pseudo-terminals but has no
  // forced kill to send, as a remote provider has none.
  const local = new LocalPTYProvider();

  const provider: ExecutionProvider = {
    kind: 'no-forced-kill',
    remote: false,
    prepareHost: local.prepareHost,
    dispose: local.dispose,
    capabilities: local.capabilities,
    spawnHarness: (spec): HarnessHandle => {
      const { killForced: _unused, ...handle } = local.spawnHarness(spec);

      return handle;
    },
    transferArchive: local.transferArchive,
    runCommand: local.runCommand,
    suspendHost: local.suspendHost,
    destroyHost: local.destroyHost,
  };

  const client = await ctx.boot(failing, provider);

  const params = {
    cwd: '/tmp',
    cols: 80,
    rows: 24,
    resume: 'agent-session-1',
    idempotencyKey: 'k-1',
  };

  const first = await client.sendRequest('session.spawn', params).catch((error: unknown) => ({
    error,
  }));

  const pid = Number(readFileSync(pidPath, 'utf8'));

  onTestFinished(() => {
    process.kill(pid, 'SIGKILL');
  });

  expect(first).toMatchObject({ error: { code: 'outcome_unknown' } });

  const effectRef = getRecord(getRecord(first, 'error'), 'data')['effectRef'];

  expect(effectRef).toBeString();

  const retried = client.sendRequest('session.spawn', params);

  expect(retried).rejects.toMatchObject({ code: 'outcome_unknown', data: { effectRef } });

  await retried.catch(() => null);

  const adopted = client.sendRequest('session.adopt', { session: effectRef, cols: 80, rows: 24 });

  expect(adopted).rejects.toMatchObject({ code: 'no_such_session' });

  await adopted.catch(() => null);

  const list = await client.sendRequest('session.list');

  expect(planned).toBe(1);
  expect(process.kill(pid, 0)).toBeTrue();
  expect(list['sessions']).toStrictEqual([expect.objectContaining({ id: effectRef })]);
}, 10_000);

test('it answers a failed spawn only once its killed process has exited, so a retry spawns once', async () => {
  await using ctx = await setupTest();

  const pidPath = join(ctx.dir, 'child.pid');
  let armed = false;
  let planned = 0;

  // The child takes 300ms to exit after SIGHUP, and the start fails only
  // once it has set that trap and written its pid.
  const failing: AgentAdapter = {
    ...idleAdapter,
    planSpawn: () => {
      planned++;
      armed = planned === 1;

      return planned === 1
        ? {
            bin: 'bash',
            args: [
              '-c',
              `trap 'sleep 0.3; exit 0' HUP; echo $$ > '${pidPath}.tmp'; mv '${pidPath}.tmp' '${pidPath}'; while :; do sleep 0.05; done`,
            ],
          }
        : { bin: 'sleep', args: ['30'] };
    },
    get headlessRunner() {
      if (armed) {
        armed = false;

        while (!existsSync(pidPath)) {
          Bun.sleepSync(10);
        }

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

  const pid = Number(readFileSync(pidPath, 'utf8'));

  expect(() => process.kill(pid, 0)).toThrow();

  const retried = await client.sendRequest('session.spawn', params);
  const list = await client.sendRequest('session.list');

  expect(planned).toBe(2);
  expect(list['sessions']).toStrictEqual([getRecord(retried, 'session')]);
});

test('it refuses to revive a failed spawn while its rollback waits for the killed process', async () => {
  await using ctx = await setupTest();

  const pidPath = join(ctx.dir, 'child.pid');
  let armed = false;
  let planned = 0;

  // The first child takes 300ms to exit after SIGHUP, and the start fails
  // only once it has set that trap and written its pid.
  const failing: AgentAdapter = {
    ...idleAdapter,
    planSpawn: () => {
      planned++;
      armed = planned === 1;

      return planned === 1
        ? {
            bin: 'bash',
            args: [
              '-c',
              `trap 'sleep 0.3; exit 0' HUP; echo $$ > '${pidPath}.tmp'; mv '${pidPath}.tmp' '${pidPath}'; while :; do sleep 0.05; done`,
            ],
          }
        : { bin: 'sleep', args: ['30'] };
    },
    get headlessRunner() {
      if (armed) {
        armed = false;

        while (!existsSync(pidPath)) {
          Bun.sleepSync(10);
        }

        throw new Error('adapter failed after the process started');
      }

      return null;
    },
  };

  const client = await ctx.boot(failing);

  const params = {
    cwd: '/tmp',
    cols: 80,
    rows: 24,
    resume: 'agent-session-1',
    idempotencyKey: 'k-1',
  };

  const first = client.sendRequest('session.spawn', params);

  const listed = await waitFor(async () => {
    const list = await client.sendRequest('session.list');

    expect(list['sessions']).toHaveLength(1);

    return list;
  });

  const id = getRecord(getRecord(listed, 'sessions'), '0')['id'];
  const adopted = client.sendRequest('session.adopt', { session: id, cols: 80, rows: 24 });

  expect(adopted).rejects.toMatchObject({ code: 'no_such_session' });

  await adopted.catch(() => null);

  expect(first).rejects.toMatchObject({ code: 'internal' });

  await first.catch(() => null);

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

test('it refuses a replay-only spawn whose key it never held as idempotency_key_unknown and spawns nothing', async () => {
  await using ctx = await setupTest();

  const client = await ctx.boot();

  const refused = client.sendRequest('session.spawn', {
    cwd: '/tmp',
    cols: 80,
    rows: 24,
    idempotencyKey: 'never-held',
    replayOnly: true,
  });

  expect(refused).rejects.toMatchObject({ code: 'idempotency_key_unknown' });

  await Promise.allSettled([refused]);

  const list = await client.sendRequest('session.list');

  expect(list['sessions']).toStrictEqual([]);
});

test('it refuses a replay-only spawn whose completed key was swept and spawns nothing more', async () => {
  await using ctx = await setupTest();

  const client = await ctx.boot();

  const params = { cwd: '/tmp', cols: 80, rows: 24, idempotencyKey: 'swept' };

  await client.sendRequest('session.spawn', params);

  const db = new Database(ctx.dbPath);

  db.run("DELETE FROM idempotency WHERE state = 'completed'");
  db.close();

  const refused = client.sendRequest('session.spawn', { ...params, replayOnly: true });

  expect(refused).rejects.toMatchObject({ code: 'idempotency_key_unknown' });

  await Promise.allSettled([refused]);

  const list = await client.sendRequest('session.list');

  expect(list['sessions']).toHaveLength(1);
});

test('it replays a held key for a replay-only spawn and message', async () => {
  await using ctx = await setupTest();

  const client = await ctx.boot({ ...idleAdapter, takesMessages: true });

  const spawnParams = { cwd: '/tmp', cols: 80, rows: 24, idempotencyKey: 'held' };

  const first = await client.sendRequest('session.spawn', spawnParams);
  const replayed = await client.sendRequest('session.spawn', { ...spawnParams, replayOnly: true });

  const session = getRecord(first, 'session')['id'];
  const messageParams = { session, text: 'hello', idempotencyKey: 'held-message' };

  const sent = await client.sendRequest('session.message', messageParams);

  const resent = await client.sendRequest('session.message', {
    ...messageParams,
    replayOnly: true,
  });

  const list = await client.sendRequest('session.list');

  expect(replayed).toMatchObject({ session: { id: session } });
  expect(resent).toStrictEqual(sent);
  expect(list['sessions']).toHaveLength(1);
});

test('it refuses replayOnly without an idempotency key as bad_args and spawns nothing', async () => {
  await using ctx = await setupTest();

  const client = await ctx.boot();

  const refused = client.sendRequest('session.spawn', { cwd: '/tmp', replayOnly: true });

  expect(refused).rejects.toMatchObject({ code: 'bad_args' });

  await Promise.allSettled([refused]);

  const list = await client.sendRequest('session.list');

  expect(list['sessions']).toStrictEqual([]);
});
