import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDaemonClient } from '@atc/protocol/client';
import {
  buildMockAgentAdapter,
  buildStubChannelOpener,
  getRecord,
  registerTestCleanup,
  setupTempDir,
  startCutProxy,
  startStubLegacyDaemon,
} from '@atc/test-utils';
import { buildMockKeyBindingClaim } from '../test-utils/build-mock-key-binding-claim';
import { buildMockRegistryDaemon } from '../test-utils/build-mock-registry-daemon';
import { startTestDaemon } from '../test-utils/start-test-daemon';
import { buildBindingPayloadHash } from './build-binding-payload-hash';
import { DaemonPool } from './daemon-pool';
import { GatewayStore } from './gateway-store';
import { RoutingCaller } from './routing-caller';
import type { RegistryDaemon } from './types';

async function setupTest() {
  const tmp = setupTempDir('atc-routing-caller-');

  // The token both listeners take, which every pool here presents.
  writeFileSync(join(tmp.path, 'token'), `${'a'.repeat(32)}\n`);

  const cloud = await startTestDaemon({
    prefix: 'atc-routing-cloud-',
    options: () => ({
      // Session messages need an adapter that takes them.
      adapter: buildMockAgentAdapter({ takesMessages: true }),

      // Lets the pools' principal use the local target.
      principals: new Map([['gw', ['local']]]),
      listen: { host: '127.0.0.1', port: 0, tokenFile: join(tmp.path, 'token') },
    }),
  });

  const pc = await startTestDaemon({
    prefix: 'atc-routing-pc-',
    options: () => ({
      adapter: buildMockAgentAdapter(),

      // Lets the pools' principal use the local target.
      principals: new Map([['gw', ['local']]]),
      listen: { host: '127.0.0.1', port: 0, tokenFile: join(tmp.path, 'token') },
    }),
  });

  const cloudProber = await openDaemonClient(cloud.socketPath);

  registerTestCleanup(() => {
    cloudProber.stop();
  });

  const pcProber = await openDaemonClient(pc.socketPath);

  registerTestCleanup(() => {
    pcProber.stop();
  });

  const cloudHello = await cloudProber.sendHello(cloud.build);
  const pcHello = await pcProber.sendHello(pc.build);

  const cloudID = String(cloudHello['daemonID']);
  const pcID = String(pcHello['daemonID']);

  const registry = {
    daemons: new Map([
      [
        'cloud',
        buildMockRegistryDaemon({
          name: 'cloud',
          address: { host: '127.0.0.1', port: Number(cloud.daemon.listenPort) },
          daemonID: cloudID,
          token: 'a'.repeat(32),
        }),
      ],
      [
        'pc',
        buildMockRegistryDaemon({
          name: 'pc',
          address: { host: '127.0.0.1', port: Number(pc.daemon.listenPort) },
          daemonID: pcID,
          token: 'a'.repeat(32),
        }),
      ],
    ]),
    defaultDaemon: 'cloud',
  };

  const storePath = join(tmp.path, 'gateway.db');
  const store = GatewayStore.open(storePath);

  registerTestCleanup(() => {
    store.stop();
  });

  const pool = new DaemonPool({
    registry,
    build: 'atc-gateway/test',
    openChannel: (address) => openDaemonClient({ hostname: address.host, port: address.port }),
  });

  registerTestCleanup(() => pool.stop());

  return {
    dir: tmp.path,
    cloud,
    pc,
    cloudID,
    registry,
    storePath,
    store,
    router: new RoutingCaller({ registry, pool, store }),
  };
}

test('it refuses a request that carries no verified client', async () => {
  const ctx = await setupTest();

  expect(ctx.router.sendRequest('dirs.list')).rejects.toThrowWithMessage(
    Error,
    'the gateway sends a request only as the verified client of the call',
  );
});

test('it runs only one of two concurrent keyed spawns with one key on two daemons', async () => {
  const ctx = await setupTest();

  const params = { cwd: ctx.dir, resume: `a-${randomUUID()}`, idempotencyKey: 'spawn-both' };

  await Promise.allSettled([
    ctx.router.sendRequest(
      'session.spawn',
      { ...params, daemon: 'cloud' },
      { id: 'gw', name: 'Lantern Notes' },
    ),
    ctx.router.sendRequest(
      'session.spawn',
      { ...params, daemon: 'pc' },
      { id: 'gw', name: 'Lantern Notes' },
    ),
  ]);

  const listed = await Promise.all([
    ctx.cloud.client.sendRequest('session.list'),
    ctx.pc.client.sendRequest('session.list'),
  ]);

  expect(listed.flatMap((list) => [list['sessions']].flat())).toHaveLength(1);
});

test('it refuses the other of two concurrent keyed spawns with one key on two daemons as idempotency_conflict', async () => {
  const ctx = await setupTest();

  const params = { cwd: ctx.dir, resume: `a-${randomUUID()}`, idempotencyKey: 'spawn-both' };

  const outcomes = await Promise.allSettled([
    ctx.router.sendRequest(
      'session.spawn',
      { ...params, daemon: 'cloud' },
      { id: 'gw', name: 'Lantern Notes' },
    ),
    ctx.router.sendRequest(
      'session.spawn',
      { ...params, daemon: 'pc' },
      { id: 'gw', name: 'Lantern Notes' },
    ),
  ]);

  expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toMatchObject([
    { status: 'rejected', reason: { code: 'idempotency_conflict' } },
  ]);
});

test('it answers two concurrent keyed spawns with one key on one daemon with the one session', async () => {
  const ctx = await setupTest();

  const params = { cwd: ctx.dir, resume: `a-${randomUUID()}`, idempotencyKey: 'spawn-twice' };

  const answers = await Promise.all([
    ctx.router.sendRequest('session.spawn', params, { id: 'gw', name: 'Lantern Notes' }),
    ctx.router.sendRequest('session.spawn', params, { id: 'gw', name: 'Lantern Notes' }),
  ]);

  const listed = await ctx.cloud.client.sendRequest('session.list');

  expect(listed['sessions']).toHaveLength(1);

  expect(getRecord(answers[0] ?? {}, 'session')['id']).toBe(
    getRecord(answers[1] ?? {}, 'session')['id'],
  );
});

test('it runs only one keyed spawn when another gateway binds its key to another daemon at once', async () => {
  const ctx = await setupTest();

  const otherStore = GatewayStore.open(ctx.storePath);

  registerTestCleanup(() => {
    otherStore.stop();
  });

  const otherPool = new DaemonPool({
    registry: ctx.registry,
    build: 'atc-gateway/test',
    openChannel: (address) => openDaemonClient({ hostname: address.host, port: address.port }),
  });

  registerTestCleanup(() => otherPool.stop());

  const other = new RoutingCaller({ registry: ctx.registry, pool: otherPool, store: otherStore });

  const params = { cwd: ctx.dir, resume: `a-${randomUUID()}`, idempotencyKey: 'spawn-shared' };

  await Promise.allSettled([
    ctx.router.sendRequest(
      'session.spawn',
      { ...params, daemon: 'cloud' },
      { id: 'gw', name: 'Lantern Notes' },
    ),
    other.sendRequest(
      'session.spawn',
      { ...params, daemon: 'pc' },
      { id: 'gw', name: 'Lantern Notes' },
    ),
  ]);

  const listed = await Promise.all([
    ctx.cloud.client.sendRequest('session.list'),
    ctx.pc.client.sendRequest('session.list'),
  ]);

  expect(listed.flatMap((list) => [list['sessions']].flat())).toHaveLength(1);
});

test('it refuses a keyed spawn whose key another gateway bound to another daemon first as idempotency_conflict', async () => {
  const ctx = await setupTest();

  const otherStore = GatewayStore.open(ctx.storePath);

  registerTestCleanup(() => {
    otherStore.stop();
  });

  const otherPool = new DaemonPool({
    registry: ctx.registry,
    build: 'atc-gateway/test',
    openChannel: (address) => openDaemonClient({ hostname: address.host, port: address.port }),
  });

  registerTestCleanup(() => otherPool.stop());

  const other = new RoutingCaller({ registry: ctx.registry, pool: otherPool, store: otherStore });

  const params = { cwd: ctx.dir, resume: `a-${randomUUID()}`, idempotencyKey: 'spawn-shared' };

  const outcomes = await Promise.allSettled([
    ctx.router.sendRequest(
      'session.spawn',
      { ...params, daemon: 'cloud' },
      { id: 'gw', name: 'Lantern Notes' },
    ),
    other.sendRequest(
      'session.spawn',
      { ...params, daemon: 'pc' },
      { id: 'gw', name: 'Lantern Notes' },
    ),
  ]);

  expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toMatchObject([
    { status: 'rejected', reason: { code: 'idempotency_conflict' } },
  ]);
});

test("it keeps another call's completed binding when a call that found none is refused before sending", async () => {
  const ctx = await setupTest();

  // A daemon behind another state identity, whose handshake the held call refuses.
  startStubLegacyDaemon(join(ctx.dir, 'legacy.sock'), {
    replies: {
      'daemon.hello': {
        daemon: 'atc/legacy-build',
        daemonID: 'd-other',
        idempotency: { completedRetentionMs: 86_400_000 },
      },
    },
  });

  const heldOpener = buildStubChannelOpener(
    [() => openDaemonClient(join(ctx.dir, 'legacy.sock'))],
    { holdDial: 1 },
  );

  const heldStore = GatewayStore.open(ctx.storePath);

  registerTestCleanup(() => {
    heldStore.stop();
  });

  const heldPool = new DaemonPool({
    registry: ctx.registry,
    build: 'atc-gateway/test',
    openChannel: heldOpener.open,
  });

  registerTestCleanup(() => heldPool.stop());

  const heldRouter = new RoutingCaller({
    registry: ctx.registry,
    pool: heldPool,
    store: heldStore,
  });

  const params = { cwd: ctx.dir, resume: `a-${randomUUID()}`, idempotencyKey: 'spawn-kept' };
  const held = heldRouter.sendRequest('session.spawn', params, { id: 'gw', name: 'Lantern Notes' });

  await heldOpener.waitForHeld();
  await ctx.router.sendRequest('session.spawn', params, { id: 'gw', name: 'Lantern Notes' });

  heldOpener.releaseHeld();

  // The held call rejects as daemon_unavailable, which another test checks;
  // here it only has to finish before the retry.
  await Promise.allSettled([held]);

  const retried = ctx.router.sendRequest(
    'session.spawn',
    { ...params, daemon: 'pc' },
    { id: 'gw', name: 'Lantern Notes' },
  );

  expect(retried).rejects.toMatchObject({ code: 'idempotency_conflict' });
  expect(ctx.pc.client.sendRequest('session.list')).resolves.toStrictEqual({ sessions: [] });
});

test('it resends an uncertain keyed spawn replay-only, so a retry after the daemon swept the key spawns nothing and answers outcome_unknown', async () => {
  const ctx = await setupTest();

  const proxy = startCutProxy({
    target: { hostname: '127.0.0.1', port: Number(ctx.cloud.daemon.listenPort) },
    method: 'session.spawn',
    cuts: 2,
    mode: 'close',
  });

  const registry = {
    daemons: new Map([
      [
        'cloud',
        buildMockRegistryDaemon({
          name: 'cloud',
          address: { host: '127.0.0.1', port: proxy.port },
          daemonID: ctx.cloudID,
          token: 'a'.repeat(32),
        }),
      ],
    ]),
    defaultDaemon: 'cloud',
  };

  const pool = new DaemonPool({
    registry,
    build: 'atc-gateway/test',
    openChannel: (address) => openDaemonClient({ hostname: address.host, port: address.port }),
  });

  registerTestCleanup(() => pool.stop());

  const router = new RoutingCaller({ registry, pool, store: ctx.store });

  const params = { cwd: ctx.dir, resume: `a-${randomUUID()}`, idempotencyKey: 'spawn-late' };

  // The first send rejects as outcome_unknown by design, so it is settled
  // rather than awaited.
  await Promise.allSettled([
    router.sendRequest('session.spawn', params, { id: 'gw', name: 'Lantern Notes' }),
  ]);

  const ledger = new Database(ctx.cloud.dbPath);

  registerTestCleanup(() => {
    ledger.close();
  });

  // The daemon's sweep drops every completed key once its retention passes.
  ledger.run("DELETE FROM idempotency WHERE state = 'completed'");

  const retried = router.sendRequest('session.spawn', params, { id: 'gw', name: 'Lantern Notes' });

  expect(retried).rejects.toMatchObject({ code: 'outcome_unknown' });
  expect(proxy.countRequests()).toBe(3);

  expect(ctx.cloud.client.sendRequest('session.list')).resolves.toStrictEqual({
    sessions: [expect.anything()],
  });
});

test('it spawns nothing for a queued keyed resend that reaches the daemon after its sweep', async () => {
  const ctx = await setupTest();

  const proxy = startCutProxy({
    target: { hostname: '127.0.0.1', port: Number(ctx.cloud.daemon.listenPort) },
    method: 'session.spawn',
    cuts: 2,
    mode: 'close',
  });

  const registry = {
    daemons: new Map([
      [
        'cloud',
        buildMockRegistryDaemon({
          name: 'cloud',
          address: { host: '127.0.0.1', port: proxy.port },
          daemonID: ctx.cloudID,
          token: 'a'.repeat(32),
        }),
      ],
    ]),
    defaultDaemon: 'cloud',
  };

  const opener = buildStubChannelOpener(
    [
      (address: RegistryDaemon['address']) =>
        openDaemonClient({ hostname: address.host, port: address.port }),
    ],
    { holdDial: 3 },
  );

  const pool = new DaemonPool({ registry, build: 'atc-gateway/test', openChannel: opener.open });

  registerTestCleanup(() => pool.stop());

  const router = new RoutingCaller({ registry, pool, store: ctx.store });

  const params = { cwd: ctx.dir, resume: `a-${randomUUID()}`, idempotencyKey: 'spawn-queued' };

  // The first send rejects as outcome_unknown by design, so it is settled
  // rather than awaited.
  await Promise.allSettled([
    router.sendRequest('session.spawn', params, { id: 'gw', name: 'Lantern Notes' }),
  ]);

  const retried = router.sendRequest('session.spawn', params, { id: 'gw', name: 'Lantern Notes' });

  await opener.waitForHeld();

  const ledger = new Database(ctx.cloud.dbPath);

  registerTestCleanup(() => {
    ledger.close();
  });

  // The daemon's sweep drops every completed key once its retention passes.
  ledger.run("DELETE FROM idempotency WHERE state = 'completed'");
  opener.releaseHeld();

  expect(retried).rejects.toMatchObject({ code: 'outcome_unknown' });
  expect(proxy.countRequests()).toBe(3);

  expect(ctx.cloud.client.sendRequest('session.list')).resolves.toStrictEqual({
    sessions: [expect.anything()],
  });
});

test('it spawns nothing for a keyed spawn whose first send never reached the daemon, and keeps its binding uncertain', async () => {
  const ctx = await setupTest();

  const proxy = startCutProxy({
    target: { hostname: '127.0.0.1', port: Number(ctx.cloud.daemon.listenPort) },
    method: 'session.spawn',
    cuts: 1,
    mode: 'drop',
  });

  const registry = {
    daemons: new Map([
      [
        'cloud',
        buildMockRegistryDaemon({
          name: 'cloud',
          address: { host: '127.0.0.1', port: proxy.port },
          daemonID: ctx.cloudID,
          token: 'a'.repeat(32),
        }),
      ],
    ]),
    defaultDaemon: 'cloud',
  };

  const pool = new DaemonPool({
    registry,
    build: 'atc-gateway/test',
    openChannel: (address) => openDaemonClient({ hostname: address.host, port: address.port }),
  });

  registerTestCleanup(() => pool.stop());

  const router = new RoutingCaller({ registry, pool, store: ctx.store });

  const params = { cwd: ctx.dir, resume: `a-${randomUUID()}`, idempotencyKey: 'spawn-dropped' };

  // The first send rejects as outcome_unknown by design, so it is settled
  // rather than awaited.
  await Promise.allSettled([
    router.sendRequest('session.spawn', params, { id: 'gw', name: 'Lantern Notes' }),
  ]);

  const retried = router.sendRequest('session.spawn', params, { id: 'gw', name: 'Lantern Notes' });

  expect(retried).rejects.toMatchObject({ code: 'outcome_unknown' });
  expect(proxy.countRequests()).toBe(3);
  expect(ctx.cloud.client.sendRequest('session.list')).resolves.toStrictEqual({ sessions: [] });

  expect(ctx.store.findBinding('gw', 'session.spawn', 'spawn-dropped')).toStrictEqual({
    principal: 'gw',
    operation: 'session.spawn',
    key: 'spawn-dropped',
    daemon: 'cloud',
    daemonID: ctx.cloudID,
    retentionMs: 86_400_000,
    payloadHash: buildBindingPayloadHash(params),
    claimID: expect.toBeString(),
    outcome: 'uncertain',
    outcomeAt: expect.toBeNumber(),
    sentAt: expect.toBeNumber(),
    effectRef: null,
  });
});

test('it runs one of two concurrent keyed spawns with one key from two gateways on one binding store', async () => {
  const ctx = await setupTest();

  const otherStore = GatewayStore.open(ctx.storePath);

  registerTestCleanup(() => {
    otherStore.stop();
  });

  const otherPool = new DaemonPool({
    registry: ctx.registry,
    build: 'atc-gateway/test',
    openChannel: (address) => openDaemonClient({ hostname: address.host, port: address.port }),
  });

  registerTestCleanup(() => otherPool.stop());

  const other = new RoutingCaller({ registry: ctx.registry, pool: otherPool, store: otherStore });

  const params = { cwd: ctx.dir, resume: `a-${randomUUID()}`, idempotencyKey: 'spawn-racing' };

  const outcomes = await Promise.allSettled([
    ctx.router.sendRequest('session.spawn', params, { id: 'gw', name: 'Lantern Notes' }),
    other.sendRequest('session.spawn', params, { id: 'gw', name: 'Lantern Notes' }),
  ]);

  expect(ctx.cloud.client.sendRequest('session.list')).resolves.toStrictEqual({
    sessions: [expect.anything()],
  });

  expect(outcomes).toPartiallyContain({ status: 'fulfilled' });
});

test('it makes the first send of a binding a gateway restart left claimed but unsent', async () => {
  const ctx = await setupTest();

  const params = { cwd: ctx.dir, resume: `a-${randomUUID()}`, idempotencyKey: 'spawn-unsent' };

  ctx.store.claimBinding(
    buildMockKeyBindingClaim({
      principal: 'gw',
      operation: 'session.spawn',
      key: 'spawn-unsent',
      daemon: 'cloud',
      daemonID: ctx.cloudID,
      retentionMs: 86_400_000,
      payloadHash: buildBindingPayloadHash(params),
    }),
    Date.now(),
  );

  const spawned = await ctx.router.sendRequest('session.spawn', params, {
    id: 'gw',
    name: 'Lantern Notes',
  });

  const listed = await ctx.cloud.client.sendRequest('session.list');

  expect(
    [listed['sessions']]
      .flat()
      .map(
        (session) =>
          `cloud.${ctx.cloudID.slice(0, 8)}.${String(getRecord({ session }, 'session')['id'])}`,
      ),
  ).toStrictEqual([String(getRecord(spawned, 'session')['id'])]);
});

test('it replays the first send of a binding a gateway restart left claimed but unsent', async () => {
  const ctx = await setupTest();

  const params = { cwd: ctx.dir, resume: `a-${randomUUID()}`, idempotencyKey: 'spawn-unsent' };

  ctx.store.claimBinding(
    buildMockKeyBindingClaim({
      principal: 'gw',
      operation: 'session.spawn',
      key: 'spawn-unsent',
      daemon: 'cloud',
      daemonID: ctx.cloudID,
      retentionMs: 86_400_000,
      payloadHash: buildBindingPayloadHash(params),
    }),
    Date.now(),
  );

  const spawned = await ctx.router.sendRequest('session.spawn', params, {
    id: 'gw',
    name: 'Lantern Notes',
  });

  const replayed = await ctx.router.sendRequest('session.spawn', params, {
    id: 'gw',
    name: 'Lantern Notes',
  });

  expect(getRecord(replayed, 'session')['id']).toBe(getRecord(spawned, 'session')['id']);

  expect(ctx.cloud.client.sendRequest('session.list')).resolves.toStrictEqual({
    sessions: [expect.anything()],
  });
});

test('it spawns nothing for a binding a gateway restart left sent but unanswered when the daemon holds no key, and returns its effectRef', async () => {
  const ctx = await setupTest();

  const params = { cwd: ctx.dir, resume: `a-${randomUUID()}`, idempotencyKey: 'spawn-sent' };

  ctx.store.claimBinding(
    buildMockKeyBindingClaim({
      principal: 'gw',
      operation: 'session.spawn',
      key: 'spawn-sent',
      daemon: 'cloud',
      daemonID: ctx.cloudID,
      retentionMs: 86_400_000,
      payloadHash: buildBindingPayloadHash(params),
    }),
    Date.now(),
  );

  ctx.store.claimFirstSend('gw', 'session.spawn', 'spawn-sent', Date.now());
  ctx.store.updateOutcome('gw', 'session.spawn', 'spawn-sent', 'uncertain', Date.now(), 's-lost');

  const retried = ctx.router.sendRequest('session.spawn', params, {
    id: 'gw',
    name: 'Lantern Notes',
  });

  expect(retried).rejects.toMatchObject({
    code: 'outcome_unknown',
    data: { effectRef: `cloud.${ctx.cloudID.slice(0, 8)}.s-lost` },
  });

  expect(ctx.cloud.client.sendRequest('session.list')).resolves.toStrictEqual({ sessions: [] });
});

test("it refuses a keyed message as idempotency_conflict when the key's first send gave the client's name as its from", async () => {
  const ctx = await setupTest();

  const spawned = await ctx.router.sendRequest(
    'session.spawn',
    { cwd: ctx.dir, resume: `a-${randomUUID()}` },
    { id: 'gw', name: 'Lantern Notes' },
  );

  const session = getRecord(spawned, 'session')['id'];

  await ctx.router.sendRequest(
    'session.message',
    {
      session,
      text: 'check the tide tables',
      from: 'Lantern Notes',
      idempotencyKey: 'message-upgrade',
    },
    { id: 'gw', name: 'Lantern Notes' },
  );

  const retried = ctx.router.sendRequest(
    'session.message',
    { session, text: 'check the tide tables', idempotencyKey: 'message-upgrade' },
    { id: 'gw', name: 'Lantern Notes' },
  );

  expect(retried).rejects.toMatchObject({ code: 'idempotency_conflict' });
});

test('it replays a keyed spawn sent before a gateway restart from the key the daemon holds, with no idempotency_conflict', async () => {
  const ctx = await setupTest();

  const proxy = startCutProxy({
    target: { hostname: '127.0.0.1', port: Number(ctx.cloud.daemon.listenPort) },
    method: 'session.spawn',
    cuts: 2,
    mode: 'close',
  });

  const registry = {
    daemons: new Map([
      [
        'cloud',
        buildMockRegistryDaemon({
          name: 'cloud',
          address: { host: '127.0.0.1', port: proxy.port },
          daemonID: ctx.cloudID,
          token: 'a'.repeat(32),
        }),
      ],
    ]),
    defaultDaemon: 'cloud',
  };

  const beforeStore = GatewayStore.open(ctx.storePath);

  registerTestCleanup(() => {
    beforeStore.stop();
  });

  const beforePool = new DaemonPool({
    registry,
    build: 'atc-gateway/test',
    openChannel: (address) => openDaemonClient({ hostname: address.host, port: address.port }),
  });

  registerTestCleanup(() => beforePool.stop());

  const before = new RoutingCaller({ registry, pool: beforePool, store: beforeStore });

  const params = { cwd: ctx.dir, resume: `a-${randomUUID()}`, idempotencyKey: 'spawn-restart' };

  // The first send rejects as outcome_unknown by design, so it is settled
  // rather than awaited.
  await Promise.allSettled([
    before.sendRequest('session.spawn', params, { id: 'gw', name: 'Lantern Notes' }),
  ]);

  const replayed = await ctx.router.sendRequest('session.spawn', params, {
    id: 'gw',
    name: 'Lantern Notes',
  });

  const listed = await ctx.cloud.client.sendRequest('session.list');

  expect(
    [listed['sessions']]
      .flat()
      .map(
        (session) =>
          `cloud.${ctx.cloudID.slice(0, 8)}.${String(getRecord({ session }, 'session')['id'])}`,
      ),
  ).toStrictEqual([String(getRecord(replayed, 'session')['id'])]);
});

test('it answers outcome_unknown for a keyed spawn sent before a gateway restart once the daemon swept its key', async () => {
  const ctx = await setupTest();

  const proxy = startCutProxy({
    target: { hostname: '127.0.0.1', port: Number(ctx.cloud.daemon.listenPort) },
    method: 'session.spawn',
    cuts: 2,
    mode: 'close',
  });

  const registry = {
    daemons: new Map([
      [
        'cloud',
        buildMockRegistryDaemon({
          name: 'cloud',
          address: { host: '127.0.0.1', port: proxy.port },
          daemonID: ctx.cloudID,
          token: 'a'.repeat(32),
        }),
      ],
    ]),
    defaultDaemon: 'cloud',
  };

  const beforeStore = GatewayStore.open(ctx.storePath);

  registerTestCleanup(() => {
    beforeStore.stop();
  });

  const beforePool = new DaemonPool({
    registry,
    build: 'atc-gateway/test',
    openChannel: (address) => openDaemonClient({ hostname: address.host, port: address.port }),
  });

  registerTestCleanup(() => beforePool.stop());

  const before = new RoutingCaller({ registry, pool: beforePool, store: beforeStore });

  const params = { cwd: ctx.dir, resume: `a-${randomUUID()}`, idempotencyKey: 'spawn-swept' };

  // The first send rejects as outcome_unknown by design, so it is settled
  // rather than awaited.
  await Promise.allSettled([
    before.sendRequest('session.spawn', params, { id: 'gw', name: 'Lantern Notes' }),
  ]);

  const ledger = new Database(ctx.cloud.dbPath);

  registerTestCleanup(() => {
    ledger.close();
  });

  // The daemon's sweep drops every completed key once its retention passes.
  ledger.run("DELETE FROM idempotency WHERE state = 'completed'");

  const retried = ctx.router.sendRequest('session.spawn', params, {
    id: 'gw',
    name: 'Lantern Notes',
  });

  expect(retried).rejects.toMatchObject({ code: 'outcome_unknown' });

  expect(ctx.cloud.client.sendRequest('session.list')).resolves.toStrictEqual({
    sessions: [expect.anything()],
  });
});

test("it passes each daemon's agent and target broker fields through agents.list unchanged", async () => {
  const ctx = await setupTest();
  const direct = await ctx.cloud.client.sendRequest('agents.list');

  const fanned = await ctx.router.sendRequest(
    'agents.list',
    {},
    { id: 'gw', name: 'Lantern Notes' },
  );

  const cloud = getRecord(getRecord(fanned, 'daemons'), 'cloud');

  expect<Record<string, unknown>>({
    agents: cloud['agents'],
    targets: cloud['targets'],
  }).toStrictEqual({
    agents: [expect.objectContaining({ id: 'claude', brokerAuth: false })],
    targets: [expect.objectContaining({ id: 'local', brokerAuth: false })],
  });

  expect<Record<string, unknown>>({
    agents: cloud['agents'],
    targets: cloud['targets'],
  }).toStrictEqual({ agents: direct['agents'], targets: direct['targets'] });
});

test('it refuses a daemon param the registry does not hold as bad_args', async () => {
  const ctx = await setupTest();

  expect(() =>
    ctx.router.sendRequest('dirs.list', { daemon: 'nope' }, { id: 'gw', name: 'Lantern Notes' }),
  ).toThrow(
    expect.objectContaining({ code: 'bad_args', message: "no daemon 'nope' in this gateway" }),
  );
});

test('it refuses a call whose ids belong to another daemon than its daemon param as bad_args', async () => {
  const ctx = await setupTest();

  expect(() =>
    ctx.router.sendRequest(
      'session.get',
      { session: `cloud.${ctx.cloudID.slice(0, 8)}.s1`, daemon: 'pc' },
      { id: 'gw', name: 'Lantern Notes' },
    ),
  ).toThrow(
    expect.objectContaining({
      code: 'bad_args',
      message: "the call's ids belong to daemon 'cloud', not 'pc'",
    }),
  );
});
