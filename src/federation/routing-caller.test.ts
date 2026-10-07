import { Database } from 'bun:sqlite';
import { expect, onTestFinished, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DaemonClient } from '../client/daemon-client';
import { startDaemon } from '../daemon/daemon';
import type { DaemonHandle } from '../daemon/daemon';
import { getRecord } from '../shared/get-record';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { startCutProxy } from '../test-utils/start-cut-proxy';
import { startLegacyDaemon } from '../test-utils/start-legacy-daemon';
import { buildBindingPayloadHash } from './build-binding-payload-hash';
import type { GatewayChannel } from './daemon-caller';
import { DaemonPool } from './daemon-pool';
import { GatewayStore } from './gateway-store';
import { RoutingCaller } from './routing-caller';
import type { GatewayRegistry, RegistryDaemon } from './types';

const TOKEN = 'r'.repeat(32);

interface RouterOptions {
  // Where the pool dials each daemon; absent dials its listener directly.
  readonly openChannel?: (address: RegistryDaemon['address']) => Promise<GatewayChannel>;

  // The address the registry holds for each daemon, by name.
  readonly addresses?: ReadonlyMap<string, RegistryDaemon['address']>;

  // The binding store's file, for routers that share one; absent opens a
  // store of the router's own.
  readonly storePath?: string;
}

/**
 * Two real daemons, `cloud` (the default) and `pc`, each with a TCP
 * listener whose token is TOKEN and a principals key that lets `gw` use
 * the local target. `startRouter` builds a routing caller over a fresh
 * pool and a binding store in the temp directory. `owner` is a daemon
 * owner's connection on its local socket, `port` its listener's port, and
 * `stateDB` the path of its state store.
 */
async function setupTest() {
  const tmp = setupTempDir('atc-routing-caller-');

  const handles = new Map<string, DaemonHandle>();
  const owners = new Map<string, DaemonClient>();
  const registryDaemons = new Map<string, RegistryDaemon>();

  for (const name of ['cloud', 'pc']) {
    const dir = join(tmp.dir, name);

    mkdirSync(dir);
    writeFileSync(join(dir, 'token'), `${TOKEN}\n`);

    const handle = await startDaemon({
      socketPath: join(dir, 'daemon.sock'),
      reporterSocketPath: join(dir, 'reporter.sock'),
      build: `atc/test-${name}`,
      adapter: {
        id: 'claude',
        screenDetector: null,
        takesMessages: true,
        headlessRunner: null,
        planSpawn: () => ({ bin: 'sleep', args: ['30'] }),
        normalizeHook: () => ({ kind: 'prompt-submitted' }),
        loadName: () => Promise.resolve(null),
        canResume: () => true,
        buildResumeCommand: () => 'claude --resume',
      },
      dbPath: join(dir, 'state.db'),
      statusPath: join(dir, 'status.json'),
      principals: new Map([['gw', ['local']]]),
      listen: { host: '127.0.0.1', port: 0, tokenFile: join(dir, 'token') },
    });

    const owner = await DaemonClient.open(join(dir, 'daemon.sock'));
    const hello = await owner.sendHello('atc/test-build');

    const daemonID = String(hello['daemonID']);

    handles.set(name, handle);
    owners.set(name, owner);

    registryDaemons.set(name, {
      name,
      address: { host: '127.0.0.1', port: handle.listenPort ?? 0 },
      daemonID,
      incarnation: daemonID.slice(0, 8),
      token: TOKEN,
    });
  }

  const getOwner = (name: string): DaemonClient => {
    const owner = owners.get(name);

    if (owner === undefined) {
      throw new Error(`no daemon '${name}'`);
    }

    return owner;
  };

  const getDaemon = (name: string): RegistryDaemon => {
    const daemon = registryDaemons.get(name);

    if (daemon === undefined) {
      throw new Error(`no daemon '${name}'`);
    }

    return daemon;
  };

  const stops: (() => Promise<void>)[] = [];

  return {
    dir: tmp.dir,
    owner: getOwner,
    daemon: getDaemon,
    stateDB: (name: string) => join(tmp.dir, name, 'state.db'),
    startRouter(options: RouterOptions = {}): RoutingCaller {
      const registry: GatewayRegistry = {
        daemons: new Map(
          [...registryDaemons].map(([name, daemon]) => [
            name,
            { ...daemon, address: options.addresses?.get(name) ?? daemon.address },
          ]),
        ),
        defaultDaemon: 'cloud',
      };

      const pool = new DaemonPool({
        registry,
        build: 'atc-gateway/test',
        openChannel:
          options.openChannel ??
          ((address) => DaemonClient.open({ hostname: address.host, port: address.port })),
      });

      const store = GatewayStore.open(
        options.storePath ?? join(tmp.dir, `gateway-${randomUUID()}.db`),
      );

      stops.push(async () => {
        await pool.stop();

        store.stop();
      });

      return new RoutingCaller({
        registry,
        pool,
        store,
      });
    },
    async [Symbol.asyncDispose]() {
      for (const stop of stops) {
        await stop();
      }

      for (const owner of owners.values()) {
        owner.stop();
      }

      for (const handle of handles.values()) {
        await handle.stop();
      }

      tmp[Symbol.dispose]();
    },
  };
}

test('it sends no read to a replacement connection whose handshake lacks the principal feature', async () => {
  await using daemons = await setupTest();

  const cloud = daemons.daemon('cloud');

  const proxy = startCutProxy({
    target: { hostname: '127.0.0.1', port: cloud.address.port },
    method: 'dirs.list',
    cuts: 1,
    mode: 'close',
  });

  const legacy = startLegacyDaemon(join(daemons.dir, 'legacy.sock'), {
    replies: {
      'daemon.hello': {
        daemon: 'atc/legacy-build',
        daemonID: cloud.daemonID,
        features: ['transport.tcp', 'daemon.id'],
      },
      'dirs.list': { dirs: ['/owner-only'] },
    },
  });

  onTestFinished(() => {
    proxy.stop();
    legacy.stop();
  });

  let opened = 0;

  const router = daemons.startRouter({
    addresses: new Map([['cloud', { host: '127.0.0.1', port: proxy.port }]]),
    openChannel: (address) => {
      opened++;

      return opened === 1
        ? DaemonClient.open({ hostname: address.host, port: address.port })
        : DaemonClient.open(join(daemons.dir, 'legacy.sock'));
    },
  });

  const read = router.sendRequest('dirs.list', {}, ['request.principal'], 'gw');

  expect(read).rejects.toMatchObject({ code: 'outcome_unknown' });

  await Promise.allSettled([read]);

  expect(legacy.requests.map((request) => request.m)).toStrictEqual(['daemon.hello']);
});

test('it runs one of two concurrent keyed spawns with one key on two daemons and refuses the other', async () => {
  await using daemons = await setupTest();

  const router = daemons.startRouter();
  const params = { cwd: '/tmp', resume: `a-${randomUUID()}`, idempotencyKey: 'spawn-both' };

  const outcomes = await Promise.allSettled([
    router.sendRequest(
      'session.spawn',
      { ...params, daemon: 'cloud' },
      ['spawn.idempotency'],
      'gw',
    ),
    router.sendRequest('session.spawn', { ...params, daemon: 'pc' }, ['spawn.idempotency'], 'gw'),
  ]);

  const cloudList = await daemons.owner('cloud').sendRequest('session.list');
  const pcList = await daemons.owner('pc').sendRequest('session.list');

  const counts = [cloudList, pcList].map((list) => [list['sessions']].flat().length);

  expect(counts.toSorted((a, b) => a - b)).toStrictEqual([0, 1]);

  expect(outcomes.map((outcome) => outcome.status).toSorted()).toStrictEqual([
    'fulfilled',
    'rejected',
  ]);

  expect(outcomes.find((outcome) => outcome.status === 'rejected')).toMatchObject({
    reason: { code: 'idempotency_conflict' },
  });
});

test('it answers two concurrent keyed spawns with one key on one daemon with the one session', async () => {
  await using daemons = await setupTest();

  const router = daemons.startRouter();
  const params = { cwd: '/tmp', resume: `a-${randomUUID()}`, idempotencyKey: 'spawn-twice' };

  const answers = await Promise.all([
    router.sendRequest('session.spawn', params, ['spawn.idempotency'], 'gw'),
    router.sendRequest('session.spawn', params, ['spawn.idempotency'], 'gw'),
  ]);

  const listed = await daemons.owner('cloud').sendRequest('session.list');

  const ids = answers.map((answer) => getRecord(answer, 'session')['id']);

  expect(listed['sessions']).toHaveLength(1);
  expect(ids[0]).toBe(ids[1]);
});

test('it refuses a keyed spawn whose key another router bound to another daemon first', async () => {
  await using daemons = await setupTest();

  const storePath = join(daemons.dir, 'shared-gateway.db');
  const first = daemons.startRouter({ storePath });
  const second = daemons.startRouter({ storePath });
  const params = { cwd: '/tmp', resume: `a-${randomUUID()}`, idempotencyKey: 'spawn-shared' };

  const outcomes = await Promise.allSettled([
    first.sendRequest('session.spawn', { ...params, daemon: 'cloud' }, ['spawn.idempotency'], 'gw'),
    second.sendRequest('session.spawn', { ...params, daemon: 'pc' }, ['spawn.idempotency'], 'gw'),
  ]);

  const cloudList = await daemons.owner('cloud').sendRequest('session.list');
  const pcList = await daemons.owner('pc').sendRequest('session.list');

  const counts = [cloudList, pcList].map((list) => [list['sessions']].flat().length);

  expect(counts.toSorted((a, b) => a - b)).toStrictEqual([0, 1]);

  expect(outcomes.find((outcome) => outcome.status === 'rejected')).toMatchObject({
    reason: { code: 'idempotency_conflict' },
  });
});

test("it keeps another call's completed binding when a call that found none is refused before sending", async () => {
  await using daemons = await setupTest();

  const cloud = daemons.daemon('cloud');
  const storePath = join(daemons.dir, 'shared-gateway.db');

  const legacy = startLegacyDaemon(join(daemons.dir, 'legacy.sock'), {
    replies: {
      'daemon.hello': {
        daemon: 'atc/legacy-build',
        daemonID: cloud.daemonID,
        features: ['transport.tcp', 'daemon.id', 'spawn.idempotency'],
        idempotency: { completedRetentionMs: 86_400_000 },
      },
    },
  });

  onTestFinished(() => {
    legacy.stop();
  });

  const dialed = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const first = daemons.startRouter({ storePath });

  const second = daemons.startRouter({
    storePath,
    openChannel: async () => {
      dialed.resolve();

      await released.promise;

      return DaemonClient.open(join(daemons.dir, 'legacy.sock'));
    },
  });

  const params = { cwd: '/tmp', resume: `a-${randomUUID()}`, idempotencyKey: 'spawn-kept' };
  const held = second.sendRequest('session.spawn', params, ['spawn.idempotency'], 'gw');

  await dialed.promise;

  await first.sendRequest('session.spawn', params, ['spawn.idempotency'], 'gw');

  released.resolve();

  expect(held).rejects.toMatchObject({ code: 'daemon_outdated' });

  await Promise.allSettled([held]);

  const retried = first.sendRequest(
    'session.spawn',
    { ...params, daemon: 'pc' },
    ['spawn.idempotency'],
    'gw',
  );

  expect(retried).rejects.toMatchObject({ code: 'idempotency_conflict' });

  await Promise.allSettled([retried]);

  const pcList = await daemons.owner('pc').sendRequest('session.list');

  expect(pcList['sessions']).toStrictEqual([]);
});

// Drops every completed key from a daemon's ledger, as its sweep does once
// the retention passes.
function removeCompletedKeys(stateDB: string): void {
  const ledger = new Database(stateDB);

  ledger.run("DELETE FROM idempotency WHERE state = 'completed'");
  ledger.close();
}

test('it resends an uncertain keyed spawn replay-only, so a retry after the daemon swept the key spawns nothing and answers outcome_unknown', async () => {
  await using daemons = await setupTest();

  const cloud = daemons.daemon('cloud');

  const proxy = startCutProxy({
    target: { hostname: '127.0.0.1', port: cloud.address.port },
    method: 'session.spawn',
    cuts: 2,
    mode: 'close',
  });

  onTestFinished(() => {
    proxy.stop();
  });

  const router = daemons.startRouter({
    addresses: new Map([['cloud', { host: '127.0.0.1', port: proxy.port }]]),
  });

  const params = { cwd: '/tmp', resume: `a-${randomUUID()}`, idempotencyKey: 'spawn-late' };
  const first = router.sendRequest('session.spawn', params, ['spawn.idempotency'], 'gw');

  expect(first).rejects.toMatchObject({ code: 'outcome_unknown' });

  await Promise.allSettled([first]);

  removeCompletedKeys(daemons.stateDB('cloud'));

  const retried = router.sendRequest('session.spawn', params, ['spawn.idempotency'], 'gw');

  expect(retried).rejects.toMatchObject({ code: 'outcome_unknown' });

  await Promise.allSettled([retried]);

  const listed = await daemons.owner('cloud').sendRequest('session.list');

  expect(proxy.countRequests()).toBe(3);
  expect(listed['sessions']).toHaveLength(1);
});

test('it spawns nothing for a queued keyed resend that reaches the daemon after its sweep', async () => {
  await using daemons = await setupTest();

  const cloud = daemons.daemon('cloud');

  const proxy = startCutProxy({
    target: { hostname: '127.0.0.1', port: cloud.address.port },
    method: 'session.spawn',
    cuts: 2,
    mode: 'close',
  });

  onTestFinished(() => {
    proxy.stop();
  });

  const dialed = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  let opened = 0;

  const router = daemons.startRouter({
    addresses: new Map([['cloud', { host: '127.0.0.1', port: proxy.port }]]),
    openChannel: async (address) => {
      opened++;

      if (opened === 3) {
        dialed.resolve();

        await released.promise;
      }

      return DaemonClient.open({ hostname: address.host, port: address.port });
    },
  });

  const params = { cwd: '/tmp', resume: `a-${randomUUID()}`, idempotencyKey: 'spawn-queued' };
  const first = router.sendRequest('session.spawn', params, ['spawn.idempotency'], 'gw');

  expect(first).rejects.toMatchObject({ code: 'outcome_unknown' });

  await Promise.allSettled([first]);

  const retried = router.sendRequest('session.spawn', params, ['spawn.idempotency'], 'gw');

  await dialed.promise;

  removeCompletedKeys(daemons.stateDB('cloud'));

  released.resolve();

  expect(retried).rejects.toMatchObject({ code: 'outcome_unknown' });

  await Promise.allSettled([retried]);

  const listed = await daemons.owner('cloud').sendRequest('session.list');

  expect(proxy.countRequests()).toBe(3);
  expect(listed['sessions']).toHaveLength(1);
});

test('it spawns nothing for a keyed spawn whose first send never reached the daemon, and keeps its binding uncertain', async () => {
  await using daemons = await setupTest();

  const cloud = daemons.daemon('cloud');
  const storePath = join(daemons.dir, 'shared-gateway.db');

  const proxy = startCutProxy({
    target: { hostname: '127.0.0.1', port: cloud.address.port },
    method: 'session.spawn',
    cuts: 1,
    mode: 'drop',
  });

  onTestFinished(() => {
    proxy.stop();
  });

  const router = daemons.startRouter({
    storePath,
    addresses: new Map([['cloud', { host: '127.0.0.1', port: proxy.port }]]),
  });

  const params = { cwd: '/tmp', resume: `a-${randomUUID()}`, idempotencyKey: 'spawn-dropped' };
  const first = router.sendRequest('session.spawn', params, ['spawn.idempotency'], 'gw');

  expect(first).rejects.toMatchObject({ code: 'outcome_unknown' });

  await Promise.allSettled([first]);

  const retried = router.sendRequest('session.spawn', params, ['spawn.idempotency'], 'gw');

  expect(retried).rejects.toMatchObject({ code: 'outcome_unknown' });

  await Promise.allSettled([retried]);

  const listed = await daemons.owner('cloud').sendRequest('session.list');

  const store = GatewayStore.open(storePath);
  const binding = store.findBinding('gw', 'session.spawn', 'spawn-dropped');

  store.stop();

  expect(proxy.countRequests()).toBe(3);
  expect(listed['sessions']).toStrictEqual([]);
  expect(binding).toMatchObject({ outcome: 'uncertain', sentAt: expect.toBeNumber() });
});

test('it runs one of two concurrent keyed spawns with one key from two routers on one gateway store', async () => {
  await using daemons = await setupTest();

  const storePath = join(daemons.dir, 'shared-gateway.db');
  const first = daemons.startRouter({ storePath });
  const second = daemons.startRouter({ storePath });
  const params = { cwd: '/tmp', resume: `a-${randomUUID()}`, idempotencyKey: 'spawn-racing' };

  const outcomes = await Promise.allSettled([
    first.sendRequest('session.spawn', params, ['spawn.idempotency'], 'gw'),
    second.sendRequest('session.spawn', params, ['spawn.idempotency'], 'gw'),
  ]);

  const listed = await daemons.owner('cloud').sendRequest('session.list');

  const answered = outcomes.filter((outcome) => outcome.status === 'fulfilled');

  expect(listed['sessions']).toHaveLength(1);
  expect(answered.length).toBeGreaterThanOrEqual(1);
});

test('it makes the first send of a binding a gateway restart left claimed but unsent, and replays it after', async () => {
  await using daemons = await setupTest();

  const cloud = daemons.daemon('cloud');
  const storePath = join(daemons.dir, 'shared-gateway.db');
  const params = { cwd: '/tmp', resume: `a-${randomUUID()}`, idempotencyKey: 'spawn-unsent' };
  const store = GatewayStore.open(storePath);

  store.claimBinding(
    {
      principal: 'gw',
      operation: 'session.spawn',
      key: 'spawn-unsent',
      daemon: 'cloud',
      daemonID: cloud.daemonID,
      retentionMs: 86_400_000,
      payloadHash: buildBindingPayloadHash(params),
      claimID: randomUUID(),
    },
    Date.now(),
  );

  store.stop();

  const router = daemons.startRouter({ storePath });

  const spawned = await router.sendRequest('session.spawn', params, ['spawn.idempotency'], 'gw');
  const replayed = await router.sendRequest('session.spawn', params, ['spawn.idempotency'], 'gw');
  const listed = await daemons.owner('cloud').sendRequest('session.list');

  expect(listed['sessions']).toHaveLength(1);
  expect(getRecord(replayed, 'session')['id']).toBe(getRecord(spawned, 'session')['id']);
});

test('it spawns nothing for a binding a gateway restart left sent but unanswered when the daemon holds no key, and returns its effectRef', async () => {
  await using daemons = await setupTest();

  const cloud = daemons.daemon('cloud');
  const storePath = join(daemons.dir, 'shared-gateway.db');
  const params = { cwd: '/tmp', resume: `a-${randomUUID()}`, idempotencyKey: 'spawn-sent' };
  const store = GatewayStore.open(storePath);

  store.claimBinding(
    {
      principal: 'gw',
      operation: 'session.spawn',
      key: 'spawn-sent',
      daemon: 'cloud',
      daemonID: cloud.daemonID,
      retentionMs: 86_400_000,
      payloadHash: buildBindingPayloadHash(params),
      claimID: randomUUID(),
    },
    Date.now(),
  );

  store.claimFirstSend('gw', 'session.spawn', 'spawn-sent', Date.now());
  store.updateOutcome('gw', 'session.spawn', 'spawn-sent', 'uncertain', Date.now(), 's-lost');
  store.stop();

  const router = daemons.startRouter({ storePath });
  const retried = router.sendRequest('session.spawn', params, ['spawn.idempotency'], 'gw');

  expect(retried).rejects.toMatchObject({
    code: 'outcome_unknown',
    data: { effectRef: `cloud.${cloud.incarnation}.s-lost` },
  });

  await Promise.allSettled([retried]);

  const listed = await daemons.owner('cloud').sendRequest('session.list');

  expect(listed['sessions']).toStrictEqual([]);
});

test('it replays a keyed spawn sent before a gateway restart from the key the daemon holds, with no idempotency_conflict', async () => {
  await using daemons = await setupTest();

  const cloud = daemons.daemon('cloud');
  const storePath = join(daemons.dir, 'shared-gateway.db');

  const proxy = startCutProxy({
    target: { hostname: '127.0.0.1', port: cloud.address.port },
    method: 'session.spawn',
    cuts: 2,
    mode: 'close',
  });

  onTestFinished(() => {
    proxy.stop();
  });

  const before = daemons.startRouter({
    storePath,
    addresses: new Map([['cloud', { host: '127.0.0.1', port: proxy.port }]]),
  });

  const params = { cwd: '/tmp', resume: `a-${randomUUID()}`, idempotencyKey: 'spawn-restart' };
  const first = before.sendRequest('session.spawn', params, ['spawn.idempotency'], 'gw');

  expect(first).rejects.toMatchObject({ code: 'outcome_unknown' });

  await Promise.allSettled([first]);

  const after = daemons.startRouter({ storePath });

  const replayed = await after.sendRequest('session.spawn', params, ['spawn.idempotency'], 'gw');
  const listed = await daemons.owner('cloud').sendRequest('session.list');

  const sessions: unknown[] = [listed['sessions']].flat();
  const listedID = String(getRecord({ listed: sessions.at(0) }, 'listed')['id']);

  expect(sessions).toHaveLength(1);
  expect(getRecord(replayed, 'session')['id']).toBe(`cloud.${cloud.incarnation}.${listedID}`);
});

test('it answers outcome_unknown for a keyed spawn sent before a gateway restart once the daemon swept its key', async () => {
  await using daemons = await setupTest();

  const cloud = daemons.daemon('cloud');
  const storePath = join(daemons.dir, 'shared-gateway.db');

  const proxy = startCutProxy({
    target: { hostname: '127.0.0.1', port: cloud.address.port },
    method: 'session.spawn',
    cuts: 2,
    mode: 'close',
  });

  onTestFinished(() => {
    proxy.stop();
  });

  const before = daemons.startRouter({
    storePath,
    addresses: new Map([['cloud', { host: '127.0.0.1', port: proxy.port }]]),
  });

  const params = { cwd: '/tmp', resume: `a-${randomUUID()}`, idempotencyKey: 'spawn-swept' };
  const first = before.sendRequest('session.spawn', params, ['spawn.idempotency'], 'gw');

  expect(first).rejects.toMatchObject({ code: 'outcome_unknown' });

  await Promise.allSettled([first]);

  removeCompletedKeys(daemons.stateDB('cloud'));

  const after = daemons.startRouter({ storePath });
  const retried = after.sendRequest('session.spawn', params, ['spawn.idempotency'], 'gw');

  expect(retried).rejects.toMatchObject({ code: 'outcome_unknown' });

  await Promise.allSettled([retried]);

  const listed = await daemons.owner('cloud').sendRequest('session.list');

  expect(listed['sessions']).toHaveLength(1);
});

test('it sends no resend of a keyed spawn to a daemon that does not announce replay-only requests', async () => {
  await using daemons = await setupTest();

  const cloud = daemons.daemon('cloud');

  const proxy = startCutProxy({
    target: { hostname: '127.0.0.1', port: cloud.address.port },
    method: 'session.spawn',
    cuts: 1,
    mode: 'close',
  });

  const legacy = startLegacyDaemon(join(daemons.dir, 'legacy.sock'), {
    replies: {
      'daemon.hello': {
        daemon: 'atc/legacy-build',
        daemonID: cloud.daemonID,
        features: ['transport.tcp', 'daemon.id', 'spawn.idempotency', 'request.principal'],
        idempotency: { completedRetentionMs: 86_400_000 },
      },
    },
  });

  onTestFinished(() => {
    proxy.stop();
    legacy.stop();
  });

  let opened = 0;

  const router = daemons.startRouter({
    addresses: new Map([['cloud', { host: '127.0.0.1', port: proxy.port }]]),
    openChannel: (address) => {
      opened++;

      return opened === 1
        ? DaemonClient.open({ hostname: address.host, port: address.port })
        : DaemonClient.open(join(daemons.dir, 'legacy.sock'));
    },
  });

  const params = { cwd: '/tmp', resume: `a-${randomUUID()}`, idempotencyKey: 'spawn-legacy' };
  const first = router.sendRequest('session.spawn', params, ['spawn.idempotency'], 'gw');

  expect(first).rejects.toMatchObject({ code: 'outcome_unknown' });

  await Promise.allSettled([first]);

  const retried = router.sendRequest('session.spawn', params, ['spawn.idempotency'], 'gw');

  expect(retried).rejects.toMatchObject({ code: 'outcome_unknown' });

  await Promise.allSettled([retried]);

  const listed = await daemons.owner('cloud').sendRequest('session.list');

  expect(legacy.requests.map((request) => request.m)).toStrictEqual(['daemon.hello']);
  expect(listed['sessions']).toHaveLength(1);
});

test("it passes each daemon's agent and target broker fields through agents.list unchanged", async () => {
  await using daemons = await setupTest();

  const router = daemons.startRouter();

  const direct = await daemons.owner('cloud').sendRequest('agents.list');
  const fanned = await router.sendRequest('agents.list', {}, ['agents.list'], 'gw');

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
