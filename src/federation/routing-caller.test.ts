import { Database } from 'bun:sqlite';
import { expect, onTestFinished, test } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DaemonClient } from '../client/daemon-client';
import { getRecord } from '../shared/get-record';
import { buildMockAgentAdapter } from '../test-utils/build-mock-agent-adapter';
import { buildStubChannelOpener } from '../test-utils/build-stub-channel-opener';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { startCutProxy } from '../test-utils/start-cut-proxy';
import { startLegacyDaemon } from '../test-utils/start-legacy-daemon';
import { startTestDaemon } from '../test-utils/start-test-daemon';
import { buildBindingPayloadHash } from './build-binding-payload-hash';
import { DaemonPool } from './daemon-pool';
import { GatewayStore } from './gateway-store';
import { RoutingCaller } from './routing-caller';
import type { RegistryDaemon } from './types';

/**
 * Two real daemons, `cloud` (the default) and `pc`, each with a TCP
 * listener on a loopback port that takes `token` and a principals key that
 * lets `gw` use the local target, and `registry`, which lists both at
 * their listeners. `router` routes over a pool that dials each listener
 * and over `store`, the binding store at `storePath`, which a test opens
 * again for a second gateway on the same bindings. `dir` takes any other
 * file a test needs.
 */
async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const tmp = stack.use(setupTempDir('atc-routing-caller-'));

  // The token both listeners take, which every pool presents.
  const token = randomBytes(16).toString('hex');

  writeFileSync(join(tmp.dir, 'token'), `${token}\n`);

  const cloud = await startTestDaemon({
    prefix: 'atc-routing-cloud-',
    options: () => ({
      adapter: buildMockAgentAdapter(),

      // Lets the pools' principal use the local target.
      principals: new Map([['gw', ['local']]]),
      listen: { host: '127.0.0.1', port: 0, tokenFile: join(tmp.dir, 'token') },
    }),
  });

  stack.use(cloud);

  const pc = await startTestDaemon({
    prefix: 'atc-routing-pc-',
    options: () => ({
      adapter: buildMockAgentAdapter(),

      // Lets the pools' principal use the local target.
      principals: new Map([['gw', ['local']]]),
      listen: { host: '127.0.0.1', port: 0, tokenFile: join(tmp.dir, 'token') },
    }),
  });

  stack.use(pc);

  const cloudProber = await DaemonClient.open(cloud.socketPath);

  stack.defer(() => {
    cloudProber.stop();
  });

  const pcProber = await DaemonClient.open(pc.socketPath);

  stack.defer(() => {
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
        {
          name: 'cloud',
          address: { host: '127.0.0.1', port: Number(cloud.daemon.listenPort) },
          daemonID: cloudID,
          incarnation: cloudID.slice(0, 8),
          token,
        },
      ],
      [
        'pc',
        {
          name: 'pc',
          address: { host: '127.0.0.1', port: Number(pc.daemon.listenPort) },
          daemonID: pcID,
          incarnation: pcID.slice(0, 8),
          token,
        },
      ],
    ]),
    defaultDaemon: 'cloud',
  };

  const storePath = join(tmp.dir, 'gateway.db');
  const store = GatewayStore.open(storePath);

  stack.defer(() => {
    store.stop();
  });

  const pool = new DaemonPool({
    registry,
    build: 'atc-gateway/test',
    openChannel: (address) => DaemonClient.open({ hostname: address.host, port: address.port }),
  });

  stack.defer(() => pool.stop());

  const owned = stack.move();

  return {
    dir: tmp.dir,
    cloud,
    pc,
    cloudID,
    token,
    registry,
    storePath,
    store,
    router: new RoutingCaller({ registry, pool, store }),
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

test('it sends no read to a replacement connection whose handshake lacks the principal feature', async () => {
  await using ctx = await setupTest();

  const proxy = startCutProxy({
    target: { hostname: '127.0.0.1', port: Number(ctx.cloud.daemon.listenPort) },
    method: 'dirs.list',
    cuts: 1,
    mode: 'close',
  });

  onTestFinished(() => {
    proxy.stop();
  });

  const legacy = startLegacyDaemon(join(ctx.dir, 'legacy.sock'), {
    replies: {
      'daemon.hello': {
        daemon: 'atc/legacy-build',
        daemonID: ctx.cloudID,
        features: ['transport.tcp', 'daemon.id'],
      },
      'dirs.list': { dirs: ['/owner-only'] },
    },
  });

  onTestFinished(() => {
    legacy.stop();
  });

  const registry = {
    daemons: new Map([
      [
        'cloud',
        {
          name: 'cloud',
          address: { host: '127.0.0.1', port: proxy.port },
          daemonID: ctx.cloudID,
          incarnation: ctx.cloudID.slice(0, 8),
          token: ctx.token,
        },
      ],
    ]),
    defaultDaemon: 'cloud',
  };

  const opener = buildStubChannelOpener([
    (address: RegistryDaemon['address']) =>
      DaemonClient.open({ hostname: address.host, port: address.port }),
    () => DaemonClient.open(join(ctx.dir, 'legacy.sock')),
  ]);

  const pool = new DaemonPool({ registry, build: 'atc-gateway/test', openChannel: opener.open });

  onTestFinished(() => pool.stop());

  const router = new RoutingCaller({ registry, pool, store: ctx.store });

  const read = router.sendRequest('dirs.list', {}, ['request.principal'], 'gw');

  expect(read).rejects.toMatchObject({ code: 'outcome_unknown' });
  expect(legacy.requests.map((request) => request.m)).toStrictEqual(['daemon.hello']);
});

test('it runs only one of two concurrent keyed spawns with one key on two daemons', async () => {
  await using ctx = await setupTest();

  const params = { cwd: ctx.dir, resume: `a-${randomUUID()}`, idempotencyKey: 'spawn-both' };

  await Promise.allSettled([
    ctx.router.sendRequest(
      'session.spawn',
      { ...params, daemon: 'cloud' },
      ['spawn.idempotency'],
      'gw',
    ),
    ctx.router.sendRequest(
      'session.spawn',
      { ...params, daemon: 'pc' },
      ['spawn.idempotency'],
      'gw',
    ),
  ]);

  const listed = await Promise.all([
    ctx.cloud.client.sendRequest('session.list'),
    ctx.pc.client.sendRequest('session.list'),
  ]);

  expect(listed.flatMap((list) => [list['sessions']].flat())).toHaveLength(1);
});

test('it refuses the other of two concurrent keyed spawns with one key on two daemons as idempotency_conflict', async () => {
  await using ctx = await setupTest();

  const params = { cwd: ctx.dir, resume: `a-${randomUUID()}`, idempotencyKey: 'spawn-both' };

  const outcomes = await Promise.allSettled([
    ctx.router.sendRequest(
      'session.spawn',
      { ...params, daemon: 'cloud' },
      ['spawn.idempotency'],
      'gw',
    ),
    ctx.router.sendRequest(
      'session.spawn',
      { ...params, daemon: 'pc' },
      ['spawn.idempotency'],
      'gw',
    ),
  ]);

  expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toMatchObject([
    { status: 'rejected', reason: { code: 'idempotency_conflict' } },
  ]);
});

test('it answers two concurrent keyed spawns with one key on one daemon with the one session', async () => {
  await using ctx = await setupTest();

  const params = { cwd: ctx.dir, resume: `a-${randomUUID()}`, idempotencyKey: 'spawn-twice' };

  const answers = await Promise.all([
    ctx.router.sendRequest('session.spawn', params, ['spawn.idempotency'], 'gw'),
    ctx.router.sendRequest('session.spawn', params, ['spawn.idempotency'], 'gw'),
  ]);

  const listed = await ctx.cloud.client.sendRequest('session.list');

  expect(listed['sessions']).toHaveLength(1);

  expect(getRecord(answers[0] ?? {}, 'session')['id']).toBe(
    getRecord(answers[1] ?? {}, 'session')['id'],
  );
});

test('it runs only one keyed spawn when another gateway binds its key to another daemon at once', async () => {
  await using ctx = await setupTest();

  const otherStore = GatewayStore.open(ctx.storePath);

  onTestFinished(() => {
    otherStore.stop();
  });

  const otherPool = new DaemonPool({
    registry: ctx.registry,
    build: 'atc-gateway/test',
    openChannel: (address) => DaemonClient.open({ hostname: address.host, port: address.port }),
  });

  onTestFinished(() => otherPool.stop());

  const other = new RoutingCaller({ registry: ctx.registry, pool: otherPool, store: otherStore });

  const params = { cwd: ctx.dir, resume: `a-${randomUUID()}`, idempotencyKey: 'spawn-shared' };

  await Promise.allSettled([
    ctx.router.sendRequest(
      'session.spawn',
      { ...params, daemon: 'cloud' },
      ['spawn.idempotency'],
      'gw',
    ),
    other.sendRequest('session.spawn', { ...params, daemon: 'pc' }, ['spawn.idempotency'], 'gw'),
  ]);

  const listed = await Promise.all([
    ctx.cloud.client.sendRequest('session.list'),
    ctx.pc.client.sendRequest('session.list'),
  ]);

  expect(listed.flatMap((list) => [list['sessions']].flat())).toHaveLength(1);
});

test('it refuses a keyed spawn whose key another gateway bound to another daemon first as idempotency_conflict', async () => {
  await using ctx = await setupTest();

  const otherStore = GatewayStore.open(ctx.storePath);

  onTestFinished(() => {
    otherStore.stop();
  });

  const otherPool = new DaemonPool({
    registry: ctx.registry,
    build: 'atc-gateway/test',
    openChannel: (address) => DaemonClient.open({ hostname: address.host, port: address.port }),
  });

  onTestFinished(() => otherPool.stop());

  const other = new RoutingCaller({ registry: ctx.registry, pool: otherPool, store: otherStore });

  const params = { cwd: ctx.dir, resume: `a-${randomUUID()}`, idempotencyKey: 'spawn-shared' };

  const outcomes = await Promise.allSettled([
    ctx.router.sendRequest(
      'session.spawn',
      { ...params, daemon: 'cloud' },
      ['spawn.idempotency'],
      'gw',
    ),
    other.sendRequest('session.spawn', { ...params, daemon: 'pc' }, ['spawn.idempotency'], 'gw'),
  ]);

  expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toMatchObject([
    { status: 'rejected', reason: { code: 'idempotency_conflict' } },
  ]);
});

test('it refuses a keyed spawn on a daemon without keyed spawns as daemon_outdated and sends it nothing', async () => {
  await using ctx = await setupTest();

  const legacy = startLegacyDaemon(join(ctx.dir, 'legacy.sock'), {
    replies: {
      'daemon.hello': {
        daemon: 'atc/legacy-build',
        daemonID: ctx.cloudID,
        features: ['transport.tcp', 'request.principal', 'daemon.id'],
      },
    },
  });

  onTestFinished(() => {
    legacy.stop();
  });

  const pool = new DaemonPool({
    registry: ctx.registry,
    build: 'atc-gateway/test',
    openChannel: () => DaemonClient.open(join(ctx.dir, 'legacy.sock')),
  });

  onTestFinished(() => pool.stop());

  const router = new RoutingCaller({ registry: ctx.registry, pool, store: ctx.store });

  const spawned = router.sendRequest(
    'session.spawn',
    { cwd: ctx.dir, idempotencyKey: 'spawn-old' },
    ['spawn.idempotency'],
    'gw',
  );

  expect(spawned).rejects.toMatchObject({
    code: 'daemon_outdated',
    message: expect.toStartWith("daemon 'cloud' "),
  });

  expect(legacy.requests.map((request) => request.m)).toStrictEqual(['daemon.hello']);
});

test('it refuses a keyed spawn as daemon_outdated when it found no binding and its daemon turns out outdated', async () => {
  await using ctx = await setupTest();

  const legacy = startLegacyDaemon(join(ctx.dir, 'legacy.sock'), {
    replies: {
      'daemon.hello': {
        daemon: 'atc/legacy-build',
        daemonID: ctx.cloudID,
        features: ['transport.tcp', 'daemon.id', 'spawn.idempotency'],
        idempotency: { completedRetentionMs: 86_400_000 },
      },
    },
  });

  onTestFinished(() => {
    legacy.stop();
  });

  const heldOpener = buildStubChannelOpener(
    [() => DaemonClient.open(join(ctx.dir, 'legacy.sock'))],
    { holdDial: 1 },
  );

  const heldStore = GatewayStore.open(ctx.storePath);

  onTestFinished(() => {
    heldStore.stop();
  });

  const heldPool = new DaemonPool({
    registry: ctx.registry,
    build: 'atc-gateway/test',
    openChannel: heldOpener.open,
  });

  onTestFinished(() => heldPool.stop());

  const heldRouter = new RoutingCaller({
    registry: ctx.registry,
    pool: heldPool,
    store: heldStore,
  });

  const params = { cwd: ctx.dir, resume: `a-${randomUUID()}`, idempotencyKey: 'spawn-kept' };
  const held = heldRouter.sendRequest('session.spawn', params, ['spawn.idempotency'], 'gw');

  await heldOpener.waitForHeld();
  await ctx.router.sendRequest('session.spawn', params, ['spawn.idempotency'], 'gw');

  heldOpener.releaseHeld();

  expect(held).rejects.toMatchObject({ code: 'daemon_outdated' });
});

test("it keeps another call's completed binding when a call that found none is refused before sending", async () => {
  await using ctx = await setupTest();

  const legacy = startLegacyDaemon(join(ctx.dir, 'legacy.sock'), {
    replies: {
      'daemon.hello': {
        daemon: 'atc/legacy-build',
        daemonID: ctx.cloudID,
        features: ['transport.tcp', 'daemon.id', 'spawn.idempotency'],
        idempotency: { completedRetentionMs: 86_400_000 },
      },
    },
  });

  onTestFinished(() => {
    legacy.stop();
  });

  const heldOpener = buildStubChannelOpener(
    [() => DaemonClient.open(join(ctx.dir, 'legacy.sock'))],
    { holdDial: 1 },
  );

  const heldStore = GatewayStore.open(ctx.storePath);

  onTestFinished(() => {
    heldStore.stop();
  });

  const heldPool = new DaemonPool({
    registry: ctx.registry,
    build: 'atc-gateway/test',
    openChannel: heldOpener.open,
  });

  onTestFinished(() => heldPool.stop());

  const heldRouter = new RoutingCaller({
    registry: ctx.registry,
    pool: heldPool,
    store: heldStore,
  });

  const params = { cwd: ctx.dir, resume: `a-${randomUUID()}`, idempotencyKey: 'spawn-kept' };
  const held = heldRouter.sendRequest('session.spawn', params, ['spawn.idempotency'], 'gw');

  await heldOpener.waitForHeld();
  await ctx.router.sendRequest('session.spawn', params, ['spawn.idempotency'], 'gw');

  heldOpener.releaseHeld();

  // The held call rejects as daemon_outdated, which another test checks;
  // here it only has to finish before the retry.
  await Promise.allSettled([held]);

  const retried = ctx.router.sendRequest(
    'session.spawn',
    { ...params, daemon: 'pc' },
    ['spawn.idempotency'],
    'gw',
  );

  expect(retried).rejects.toMatchObject({ code: 'idempotency_conflict' });
  expect(ctx.pc.client.sendRequest('session.list')).resolves.toStrictEqual({ sessions: [] });
});

test('it resends an uncertain keyed spawn replay-only, so a retry after the daemon swept the key spawns nothing and answers outcome_unknown', async () => {
  await using ctx = await setupTest();

  const proxy = startCutProxy({
    target: { hostname: '127.0.0.1', port: Number(ctx.cloud.daemon.listenPort) },
    method: 'session.spawn',
    cuts: 2,
    mode: 'close',
  });

  onTestFinished(() => {
    proxy.stop();
  });

  const registry = {
    daemons: new Map([
      [
        'cloud',
        {
          name: 'cloud',
          address: { host: '127.0.0.1', port: proxy.port },
          daemonID: ctx.cloudID,
          incarnation: ctx.cloudID.slice(0, 8),
          token: ctx.token,
        },
      ],
    ]),
    defaultDaemon: 'cloud',
  };

  const pool = new DaemonPool({
    registry,
    build: 'atc-gateway/test',
    openChannel: (address) => DaemonClient.open({ hostname: address.host, port: address.port }),
  });

  onTestFinished(() => pool.stop());

  const router = new RoutingCaller({ registry, pool, store: ctx.store });

  const params = { cwd: ctx.dir, resume: `a-${randomUUID()}`, idempotencyKey: 'spawn-late' };

  // The first send rejects as outcome_unknown by design, so it is settled
  // rather than awaited.
  await Promise.allSettled([
    router.sendRequest('session.spawn', params, ['spawn.idempotency'], 'gw'),
  ]);

  const ledger = new Database(ctx.cloud.dbPath);

  onTestFinished(() => {
    ledger.close();
  });

  // The daemon's sweep drops every completed key once its retention passes.
  ledger.run("DELETE FROM idempotency WHERE state = 'completed'");

  const retried = router.sendRequest('session.spawn', params, ['spawn.idempotency'], 'gw');

  expect(retried).rejects.toMatchObject({ code: 'outcome_unknown' });
  expect(proxy.countRequests()).toBe(3);

  expect(ctx.cloud.client.sendRequest('session.list')).resolves.toStrictEqual({
    sessions: [expect.anything()],
  });
});

test('it spawns nothing for a queued keyed resend that reaches the daemon after its sweep', async () => {
  await using ctx = await setupTest();

  const proxy = startCutProxy({
    target: { hostname: '127.0.0.1', port: Number(ctx.cloud.daemon.listenPort) },
    method: 'session.spawn',
    cuts: 2,
    mode: 'close',
  });

  onTestFinished(() => {
    proxy.stop();
  });

  const registry = {
    daemons: new Map([
      [
        'cloud',
        {
          name: 'cloud',
          address: { host: '127.0.0.1', port: proxy.port },
          daemonID: ctx.cloudID,
          incarnation: ctx.cloudID.slice(0, 8),
          token: ctx.token,
        },
      ],
    ]),
    defaultDaemon: 'cloud',
  };

  const opener = buildStubChannelOpener(
    [
      (address: RegistryDaemon['address']) =>
        DaemonClient.open({ hostname: address.host, port: address.port }),
    ],
    { holdDial: 3 },
  );

  const pool = new DaemonPool({ registry, build: 'atc-gateway/test', openChannel: opener.open });

  onTestFinished(() => pool.stop());

  const router = new RoutingCaller({ registry, pool, store: ctx.store });

  const params = { cwd: ctx.dir, resume: `a-${randomUUID()}`, idempotencyKey: 'spawn-queued' };

  // The first send rejects as outcome_unknown by design, so it is settled
  // rather than awaited.
  await Promise.allSettled([
    router.sendRequest('session.spawn', params, ['spawn.idempotency'], 'gw'),
  ]);

  const retried = router.sendRequest('session.spawn', params, ['spawn.idempotency'], 'gw');

  await opener.waitForHeld();

  const ledger = new Database(ctx.cloud.dbPath);

  onTestFinished(() => {
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
  await using ctx = await setupTest();

  const proxy = startCutProxy({
    target: { hostname: '127.0.0.1', port: Number(ctx.cloud.daemon.listenPort) },
    method: 'session.spawn',
    cuts: 1,
    mode: 'drop',
  });

  onTestFinished(() => {
    proxy.stop();
  });

  const registry = {
    daemons: new Map([
      [
        'cloud',
        {
          name: 'cloud',
          address: { host: '127.0.0.1', port: proxy.port },
          daemonID: ctx.cloudID,
          incarnation: ctx.cloudID.slice(0, 8),
          token: ctx.token,
        },
      ],
    ]),
    defaultDaemon: 'cloud',
  };

  const pool = new DaemonPool({
    registry,
    build: 'atc-gateway/test',
    openChannel: (address) => DaemonClient.open({ hostname: address.host, port: address.port }),
  });

  onTestFinished(() => pool.stop());

  const router = new RoutingCaller({ registry, pool, store: ctx.store });

  const params = { cwd: ctx.dir, resume: `a-${randomUUID()}`, idempotencyKey: 'spawn-dropped' };

  // The first send rejects as outcome_unknown by design, so it is settled
  // rather than awaited.
  await Promise.allSettled([
    router.sendRequest('session.spawn', params, ['spawn.idempotency'], 'gw'),
  ]);

  const retried = router.sendRequest('session.spawn', params, ['spawn.idempotency'], 'gw');

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
  await using ctx = await setupTest();

  const otherStore = GatewayStore.open(ctx.storePath);

  onTestFinished(() => {
    otherStore.stop();
  });

  const otherPool = new DaemonPool({
    registry: ctx.registry,
    build: 'atc-gateway/test',
    openChannel: (address) => DaemonClient.open({ hostname: address.host, port: address.port }),
  });

  onTestFinished(() => otherPool.stop());

  const other = new RoutingCaller({ registry: ctx.registry, pool: otherPool, store: otherStore });

  const params = { cwd: ctx.dir, resume: `a-${randomUUID()}`, idempotencyKey: 'spawn-racing' };

  const outcomes = await Promise.allSettled([
    ctx.router.sendRequest('session.spawn', params, ['spawn.idempotency'], 'gw'),
    other.sendRequest('session.spawn', params, ['spawn.idempotency'], 'gw'),
  ]);

  expect(ctx.cloud.client.sendRequest('session.list')).resolves.toStrictEqual({
    sessions: [expect.anything()],
  });

  expect(outcomes).toPartiallyContain({ status: 'fulfilled' });
});

test('it makes the first send of a binding a gateway restart left claimed but unsent', async () => {
  await using ctx = await setupTest();

  const params = { cwd: ctx.dir, resume: `a-${randomUUID()}`, idempotencyKey: 'spawn-unsent' };

  ctx.store.claimBinding(
    {
      principal: 'gw',
      operation: 'session.spawn',
      key: 'spawn-unsent',
      daemon: 'cloud',
      daemonID: ctx.cloudID,
      retentionMs: 86_400_000,
      payloadHash: buildBindingPayloadHash(params),
      claimID: randomUUID(),
    },
    Date.now(),
  );

  const spawned = await ctx.router.sendRequest(
    'session.spawn',
    params,
    ['spawn.idempotency'],
    'gw',
  );

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
  await using ctx = await setupTest();

  const params = { cwd: ctx.dir, resume: `a-${randomUUID()}`, idempotencyKey: 'spawn-unsent' };

  ctx.store.claimBinding(
    {
      principal: 'gw',
      operation: 'session.spawn',
      key: 'spawn-unsent',
      daemon: 'cloud',
      daemonID: ctx.cloudID,
      retentionMs: 86_400_000,
      payloadHash: buildBindingPayloadHash(params),
      claimID: randomUUID(),
    },
    Date.now(),
  );

  const spawned = await ctx.router.sendRequest(
    'session.spawn',
    params,
    ['spawn.idempotency'],
    'gw',
  );

  const replayed = await ctx.router.sendRequest(
    'session.spawn',
    params,
    ['spawn.idempotency'],
    'gw',
  );

  expect(getRecord(replayed, 'session')['id']).toBe(getRecord(spawned, 'session')['id']);

  expect(ctx.cloud.client.sendRequest('session.list')).resolves.toStrictEqual({
    sessions: [expect.anything()],
  });
});

test('it spawns nothing for a binding a gateway restart left sent but unanswered when the daemon holds no key, and returns its effectRef', async () => {
  await using ctx = await setupTest();

  const params = { cwd: ctx.dir, resume: `a-${randomUUID()}`, idempotencyKey: 'spawn-sent' };

  ctx.store.claimBinding(
    {
      principal: 'gw',
      operation: 'session.spawn',
      key: 'spawn-sent',
      daemon: 'cloud',
      daemonID: ctx.cloudID,
      retentionMs: 86_400_000,
      payloadHash: buildBindingPayloadHash(params),
      claimID: randomUUID(),
    },
    Date.now(),
  );

  ctx.store.claimFirstSend('gw', 'session.spawn', 'spawn-sent', Date.now());
  ctx.store.updateOutcome('gw', 'session.spawn', 'spawn-sent', 'uncertain', Date.now(), 's-lost');

  const retried = ctx.router.sendRequest('session.spawn', params, ['spawn.idempotency'], 'gw');

  expect(retried).rejects.toMatchObject({
    code: 'outcome_unknown',
    data: { effectRef: `cloud.${ctx.cloudID.slice(0, 8)}.s-lost` },
  });

  expect(ctx.cloud.client.sendRequest('session.list')).resolves.toStrictEqual({ sessions: [] });
});

test('it replays a keyed spawn sent before a gateway restart from the key the daemon holds, with no idempotency_conflict', async () => {
  await using ctx = await setupTest();

  const proxy = startCutProxy({
    target: { hostname: '127.0.0.1', port: Number(ctx.cloud.daemon.listenPort) },
    method: 'session.spawn',
    cuts: 2,
    mode: 'close',
  });

  onTestFinished(() => {
    proxy.stop();
  });

  const registry = {
    daemons: new Map([
      [
        'cloud',
        {
          name: 'cloud',
          address: { host: '127.0.0.1', port: proxy.port },
          daemonID: ctx.cloudID,
          incarnation: ctx.cloudID.slice(0, 8),
          token: ctx.token,
        },
      ],
    ]),
    defaultDaemon: 'cloud',
  };

  const beforeStore = GatewayStore.open(ctx.storePath);

  onTestFinished(() => {
    beforeStore.stop();
  });

  const beforePool = new DaemonPool({
    registry,
    build: 'atc-gateway/test',
    openChannel: (address) => DaemonClient.open({ hostname: address.host, port: address.port }),
  });

  onTestFinished(() => beforePool.stop());

  const before = new RoutingCaller({ registry, pool: beforePool, store: beforeStore });

  const params = { cwd: ctx.dir, resume: `a-${randomUUID()}`, idempotencyKey: 'spawn-restart' };

  // The first send rejects as outcome_unknown by design, so it is settled
  // rather than awaited.
  await Promise.allSettled([
    before.sendRequest('session.spawn', params, ['spawn.idempotency'], 'gw'),
  ]);

  const replayed = await ctx.router.sendRequest(
    'session.spawn',
    params,
    ['spawn.idempotency'],
    'gw',
  );

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
  await using ctx = await setupTest();

  const proxy = startCutProxy({
    target: { hostname: '127.0.0.1', port: Number(ctx.cloud.daemon.listenPort) },
    method: 'session.spawn',
    cuts: 2,
    mode: 'close',
  });

  onTestFinished(() => {
    proxy.stop();
  });

  const registry = {
    daemons: new Map([
      [
        'cloud',
        {
          name: 'cloud',
          address: { host: '127.0.0.1', port: proxy.port },
          daemonID: ctx.cloudID,
          incarnation: ctx.cloudID.slice(0, 8),
          token: ctx.token,
        },
      ],
    ]),
    defaultDaemon: 'cloud',
  };

  const beforeStore = GatewayStore.open(ctx.storePath);

  onTestFinished(() => {
    beforeStore.stop();
  });

  const beforePool = new DaemonPool({
    registry,
    build: 'atc-gateway/test',
    openChannel: (address) => DaemonClient.open({ hostname: address.host, port: address.port }),
  });

  onTestFinished(() => beforePool.stop());

  const before = new RoutingCaller({ registry, pool: beforePool, store: beforeStore });

  const params = { cwd: ctx.dir, resume: `a-${randomUUID()}`, idempotencyKey: 'spawn-swept' };

  // The first send rejects as outcome_unknown by design, so it is settled
  // rather than awaited.
  await Promise.allSettled([
    before.sendRequest('session.spawn', params, ['spawn.idempotency'], 'gw'),
  ]);

  const ledger = new Database(ctx.cloud.dbPath);

  onTestFinished(() => {
    ledger.close();
  });

  // The daemon's sweep drops every completed key once its retention passes.
  ledger.run("DELETE FROM idempotency WHERE state = 'completed'");

  const retried = ctx.router.sendRequest('session.spawn', params, ['spawn.idempotency'], 'gw');

  expect(retried).rejects.toMatchObject({ code: 'outcome_unknown' });

  expect(ctx.cloud.client.sendRequest('session.list')).resolves.toStrictEqual({
    sessions: [expect.anything()],
  });
});

test('it sends no resend of a keyed spawn to a daemon that does not announce replay-only requests', async () => {
  await using ctx = await setupTest();

  const proxy = startCutProxy({
    target: { hostname: '127.0.0.1', port: Number(ctx.cloud.daemon.listenPort) },
    method: 'session.spawn',
    cuts: 1,
    mode: 'close',
  });

  onTestFinished(() => {
    proxy.stop();
  });

  const legacy = startLegacyDaemon(join(ctx.dir, 'legacy.sock'), {
    replies: {
      'daemon.hello': {
        daemon: 'atc/legacy-build',
        daemonID: ctx.cloudID,
        features: ['transport.tcp', 'daemon.id', 'spawn.idempotency', 'request.principal'],
        idempotency: { completedRetentionMs: 86_400_000 },
      },
    },
  });

  onTestFinished(() => {
    legacy.stop();
  });

  const registry = {
    daemons: new Map([
      [
        'cloud',
        {
          name: 'cloud',
          address: { host: '127.0.0.1', port: proxy.port },
          daemonID: ctx.cloudID,
          incarnation: ctx.cloudID.slice(0, 8),
          token: ctx.token,
        },
      ],
    ]),
    defaultDaemon: 'cloud',
  };

  const opener = buildStubChannelOpener([
    (address: RegistryDaemon['address']) =>
      DaemonClient.open({ hostname: address.host, port: address.port }),
    () => DaemonClient.open(join(ctx.dir, 'legacy.sock')),
  ]);

  const pool = new DaemonPool({ registry, build: 'atc-gateway/test', openChannel: opener.open });

  onTestFinished(() => pool.stop());

  const router = new RoutingCaller({ registry, pool, store: ctx.store });

  const params = { cwd: ctx.dir, resume: `a-${randomUUID()}`, idempotencyKey: 'spawn-legacy' };

  // The first send rejects as outcome_unknown by design, so it is settled
  // rather than awaited.
  await Promise.allSettled([
    router.sendRequest('session.spawn', params, ['spawn.idempotency'], 'gw'),
  ]);

  const retried = router.sendRequest('session.spawn', params, ['spawn.idempotency'], 'gw');

  expect(retried).rejects.toMatchObject({ code: 'outcome_unknown' });
  expect(legacy.requests.map((request) => request.m)).toStrictEqual(['daemon.hello']);

  expect(ctx.cloud.client.sendRequest('session.list')).resolves.toStrictEqual({
    sessions: [expect.anything()],
  });
});

test("it passes each daemon's agent and target broker fields through agents.list unchanged", async () => {
  await using ctx = await setupTest();

  const direct = await ctx.cloud.client.sendRequest('agents.list');
  const fanned = await ctx.router.sendRequest('agents.list', {}, ['agents.list'], 'gw');

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
  await using ctx = await setupTest();

  expect(() =>
    ctx.router.sendRequest('dirs.list', { daemon: 'nope' }, ['request.principal'], 'gw'),
  ).toThrow(
    expect.objectContaining({ code: 'bad_args', message: "no daemon 'nope' in this gateway" }),
  );
});

test('it refuses a call whose ids belong to another daemon than its daemon param as bad_args', async () => {
  await using ctx = await setupTest();

  expect(() =>
    ctx.router.sendRequest(
      'session.get',
      { session: `cloud.${ctx.cloudID.slice(0, 8)}.s1`, daemon: 'pc' },
      [],
      'gw',
    ),
  ).toThrow(
    expect.objectContaining({
      code: 'bad_args',
      message: "the call's ids belong to daemon 'cloud', not 'pc'",
    }),
  );
});
