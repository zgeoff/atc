import { Database } from 'bun:sqlite';
import { expect, onTestFinished, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '../../test/setup-temp-dir';
import { startCutProxy } from '../../test/start-cut-proxy';
import { startLegacyDaemon } from '../../test/start-legacy-daemon';
import { DaemonClient } from '../client/daemon-client';
import { startDaemon } from '../daemon/daemon';
import { getRecord } from '../shared/get-record';
import { DaemonCaller } from './daemon-caller';

const TOKEN = 'g'.repeat(32);

/**
 * A real daemon with a TCP listener on a loopback port whose token file
 * holds TOKEN and whose principals key lets `gw` use the local target.
 * `owner` is the daemon owner's connection on its local socket,
 * `daemonID` is the state identity its handshake returns, and `dbPath` is
 * its state store.
 */
async function setupTest() {
  const tmp = setupTempDir('atc-daemon-caller-');
  const tokenFile = join(tmp.dir, 'gateway-token');

  writeFileSync(tokenFile, `${TOKEN}\n`);

  const daemon = await startDaemon({
    socketPath: join(tmp.dir, 'daemon.sock'),
    reporterSocketPath: join(tmp.dir, 'reporter.sock'),
    build: 'atc/test-build',
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
    dbPath: join(tmp.dir, 'state.db'),
    statusPath: join(tmp.dir, 'status.json'),
    principals: new Map([['gw', ['local']]]),
    listen: { host: '127.0.0.1', port: 0, tokenFile },
  });

  const owner = await DaemonClient.open(join(tmp.dir, 'daemon.sock'));
  const hello = await owner.sendHello('atc/test-build');

  if (daemon.listenPort === null) {
    throw new Error('the daemon started without a TCP listener');
  }

  return {
    dbPath: join(tmp.dir, 'state.db'),
    port: daemon.listenPort,
    owner,
    daemonID: String(hello['daemonID']),
    async [Symbol.asyncDispose]() {
      owner.stop();

      await daemon.stop();

      tmp[Symbol.dispose]();
    },
  };
}

test('it answers a request through a daemon whose handshake returns the pinned id', async () => {
  await using daemon = await setupTest();

  const caller = new DaemonCaller({
    daemon: {
      name: 'cloud',
      address: { host: '127.0.0.1', port: daemon.port },
      daemonID: daemon.daemonID,
      incarnation: daemon.daemonID.slice(0, 8),
      token: TOKEN,
    },
    build: 'atc-gateway/test',
    openChannel: (address) => DaemonClient.open({ hostname: address.host, port: address.port }),
  });

  onTestFinished(() => caller.stop());

  const listed = await caller.sendRequest('session.list', {}, 'gw');

  expect(listed).toStrictEqual({ sessions: [] });
});

test('it reads the build, features, and key retention from the handshake', async () => {
  await using daemon = await setupTest();

  const caller = new DaemonCaller({
    daemon: {
      name: 'cloud',
      address: { host: '127.0.0.1', port: daemon.port },
      daemonID: daemon.daemonID,
      incarnation: daemon.daemonID.slice(0, 8),
      token: TOKEN,
    },
    build: 'atc-gateway/test',
    openChannel: (address) => DaemonClient.open({ hostname: address.host, port: address.port }),
  });

  onTestFinished(() => caller.stop());

  const hello = await caller.readHello();

  expect(hello).toMatchObject({
    build: 'atc/test-build',
    daemonID: daemon.daemonID,
    retentionMs: 86_400_000,
  });

  expect(hello.features.has('transport.tcp')).toBeTrue();
});

test('it refuses a daemon behind another state identity as daemon_changed and sends it nothing', async () => {
  await using daemon = await setupTest();

  const caller = new DaemonCaller({
    daemon: {
      name: 'cloud',
      address: { host: '127.0.0.1', port: daemon.port },
      daemonID: '0f6c2a8e-3d51-4b7a-9c2e-5a8d1e4f7b30',
      incarnation: '0f6c2a8e',
      token: TOKEN,
    },
    build: 'atc-gateway/test',
    openChannel: (address) => DaemonClient.open({ hostname: address.host, port: address.port }),
  });

  onTestFinished(() => caller.stop());

  expect(
    caller.sendRequest('session.spawn', { cwd: '/tmp', resume: `a-${randomUUID()}` }, 'gw'),
  ).rejects.toMatchObject({
    code: 'daemon_unavailable',
    data: { daemon: 'cloud', reason: 'daemon_changed' },
  });

  const listed = await daemon.owner.sendRequest('session.list');

  expect(listed).toStrictEqual({ sessions: [] });
});

test('it refuses a daemon that rejects the token as daemon_unauthorized', async () => {
  await using daemon = await setupTest();

  const caller = new DaemonCaller({
    daemon: {
      name: 'cloud',
      address: { host: '127.0.0.1', port: daemon.port },
      daemonID: daemon.daemonID,
      incarnation: daemon.daemonID.slice(0, 8),
      token: 'w'.repeat(32),
    },
    build: 'atc-gateway/test',
    openChannel: (address) => DaemonClient.open({ hostname: address.host, port: address.port }),
  });

  onTestFinished(() => caller.stop());

  expect(caller.sendRequest('session.list', {}, 'gw')).rejects.toMatchObject({
    code: 'daemon_unauthorized',
    data: { daemon: 'cloud' },
  });
});

test('it refuses a daemon nothing listens for as daemon_unavailable', () => {
  const probe = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const port = probe.port;

  probe.stop(true);

  const caller = new DaemonCaller({
    daemon: {
      name: 'cloud',
      address: { host: '127.0.0.1', port },
      daemonID: '0f6c2a8e-3d51-4b7a-9c2e-5a8d1e4f7b30',
      incarnation: '0f6c2a8e',
      token: TOKEN,
    },
    build: 'atc-gateway/test',
    openChannel: (address) => DaemonClient.open({ hostname: address.host, port: address.port }),
  });

  onTestFinished(() => caller.stop());

  expect(caller.sendRequest('session.list', {}, 'gw')).rejects.toMatchObject({
    code: 'daemon_unavailable',
    data: { daemon: 'cloud' },
  });
});

test("it passes a daemon's own error through with its code", async () => {
  await using daemon = await setupTest();

  const caller = new DaemonCaller({
    daemon: {
      name: 'cloud',
      address: { host: '127.0.0.1', port: daemon.port },
      daemonID: daemon.daemonID,
      incarnation: daemon.daemonID.slice(0, 8),
      token: TOKEN,
    },
    build: 'atc-gateway/test',
    openChannel: (address) => DaemonClient.open({ hostname: address.host, port: address.port }),
  });

  onTestFinished(() => caller.stop());

  expect(caller.sendRequest('session.get', { session: 'nope' }, 'gw')).rejects.toMatchObject({
    code: 'no_such_session',
    message: "no session 'nope'",
  });
});

test('it retries a keyed spawn whose response was lost once on the same daemon, which spawns once', async () => {
  await using daemon = await setupTest();

  const proxy = startCutProxy({
    target: { hostname: '127.0.0.1', port: daemon.port },
    method: 'session.spawn',
    cuts: 1,
    mode: 'close',
  });

  onTestFinished(() => {
    proxy.stop();
  });

  const caller = new DaemonCaller({
    daemon: {
      name: 'cloud',
      address: { host: '127.0.0.1', port: proxy.port },
      daemonID: daemon.daemonID,
      incarnation: daemon.daemonID.slice(0, 8),
      token: TOKEN,
    },
    build: 'atc-gateway/test',
    openChannel: (address) => DaemonClient.open({ hostname: address.host, port: address.port }),
  });

  onTestFinished(() => caller.stop());

  const spawned = await caller.sendRequest(
    'session.spawn',
    { cwd: '/tmp', resume: `a-${randomUUID()}`, idempotencyKey: 'spawn-1' },
    'gw',
  );

  const listed = await daemon.owner.sendRequest('session.list');

  expect(proxy.countRequests()).toBe(2);

  expect(listed).toStrictEqual({
    sessions: [expect.objectContaining({ id: getRecord(spawned, 'session')['id'] })],
  });
});

test('it answers outcome_unknown for an unkeyed spawn whose response was lost', async () => {
  await using daemon = await setupTest();

  const proxy = startCutProxy({
    target: { hostname: '127.0.0.1', port: daemon.port },
    method: 'session.spawn',
    cuts: 1,
    mode: 'close',
  });

  onTestFinished(() => {
    proxy.stop();
  });

  const caller = new DaemonCaller({
    daemon: {
      name: 'cloud',
      address: { host: '127.0.0.1', port: proxy.port },
      daemonID: daemon.daemonID,
      incarnation: daemon.daemonID.slice(0, 8),
      token: TOKEN,
    },
    build: 'atc-gateway/test',
    openChannel: (address) => DaemonClient.open({ hostname: address.host, port: address.port }),
  });

  onTestFinished(() => caller.stop());

  expect(
    caller.sendRequest('session.spawn', { cwd: '/tmp', resume: `a-${randomUUID()}` }, 'gw'),
  ).rejects.toMatchObject({ code: 'outcome_unknown', data: { daemon: 'cloud' } });

  expect(proxy.countRequests()).toBe(1);
});

test('it answers outcome_unknown for a keyed spawn whose retry also lost its response', async () => {
  await using daemon = await setupTest();

  const proxy = startCutProxy({
    target: { hostname: '127.0.0.1', port: daemon.port },
    method: 'session.spawn',
    cuts: 2,
    mode: 'close',
  });

  onTestFinished(() => {
    proxy.stop();
  });

  const caller = new DaemonCaller({
    daemon: {
      name: 'cloud',
      address: { host: '127.0.0.1', port: proxy.port },
      daemonID: daemon.daemonID,
      incarnation: daemon.daemonID.slice(0, 8),
      token: TOKEN,
    },
    build: 'atc-gateway/test',
    openChannel: (address) => DaemonClient.open({ hostname: address.host, port: address.port }),
  });

  onTestFinished(() => caller.stop());

  expect(
    caller.sendRequest(
      'session.spawn',
      { cwd: '/tmp', resume: `a-${randomUUID()}`, idempotencyKey: 'spawn-2' },
      'gw',
    ),
  ).rejects.toMatchObject({ code: 'outcome_unknown', data: { daemon: 'cloud' } });

  expect(proxy.countRequests()).toBe(2);
});

test('it retries a keyed spawn whose response timed out on a fresh connection', async () => {
  await using daemon = await setupTest();

  const proxy = startCutProxy({
    target: { hostname: '127.0.0.1', port: daemon.port },
    method: 'session.spawn',
    cuts: 1,
    mode: 'hold',
  });

  onTestFinished(() => {
    proxy.stop();
  });

  const caller = new DaemonCaller({
    daemon: {
      name: 'cloud',
      address: { host: '127.0.0.1', port: proxy.port },
      daemonID: daemon.daemonID,
      incarnation: daemon.daemonID.slice(0, 8),
      token: TOKEN,
    },
    build: 'atc-gateway/test',
    openChannel: (address) => DaemonClient.open({ hostname: address.host, port: address.port }),
    responseTimeoutMs: 500,
  });

  onTestFinished(() => caller.stop());

  const spawned = await caller.sendRequest(
    'session.spawn',
    { cwd: '/tmp', resume: `a-${randomUUID()}`, idempotencyKey: 'spawn-3' },
    'gw',
  );

  const listed = await daemon.owner.sendRequest('session.list');

  expect(listed).toStrictEqual({
    sessions: [expect.objectContaining({ id: getRecord(spawned, 'session')['id'] })],
  });
});

test('it refuses a daemon that never answers the handshake as daemon_unavailable', () => {
  const silent = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });

  onTestFinished(() => {
    silent.stop(true);
  });

  const caller = new DaemonCaller({
    daemon: {
      name: 'cloud',
      address: { host: '127.0.0.1', port: silent.port },
      daemonID: '0f6c2a8e-3d51-4b7a-9c2e-5a8d1e4f7b30',
      incarnation: '0f6c2a8e',
      token: TOKEN,
    },
    build: 'atc-gateway/test',
    openChannel: (address) => DaemonClient.open({ hostname: address.host, port: address.port }),
    connectTimeoutMs: 300,
  });

  onTestFinished(() => caller.stop());

  const started = Date.now();

  expect(caller.sendRequest('session.list', {}, 'gw')).rejects.toMatchObject({
    code: 'daemon_unavailable',
    message: "daemon 'cloud' did not answer the connection in time",
  });

  expect(Date.now() - started).toBeWithin(250, 5000);
});

test('it answers outcome_unknown instead of retrying a keyed spawn on a reconnect that no longer takes keys', async () => {
  await using daemon = await setupTest();
  await using tmp = setupTempDir('atc-daemon-caller-legacy-');

  const proxy = startCutProxy({
    target: { hostname: '127.0.0.1', port: daemon.port },
    method: 'session.spawn',
    cuts: 1,
    mode: 'close',
  });

  const legacy = startLegacyDaemon(join(tmp.dir, 'legacy.sock'), {
    features: ['transport.tcp', 'request.principal'],
    replies: {
      'daemon.hello': {
        daemon: 'atc/legacy-build',
        daemonID: daemon.daemonID,
        features: ['transport.tcp'],
      },
    },
  });

  onTestFinished(() => {
    proxy.stop();
    legacy.stop();
  });

  let opened = 0;

  const caller = new DaemonCaller({
    daemon: {
      name: 'cloud',
      address: { host: '127.0.0.1', port: proxy.port },
      daemonID: daemon.daemonID,
      incarnation: daemon.daemonID.slice(0, 8),
      token: TOKEN,
    },
    build: 'atc-gateway/test',
    openChannel: (address) => {
      opened++;

      return opened === 1
        ? DaemonClient.open({ hostname: address.host, port: address.port })
        : DaemonClient.open(join(tmp.dir, 'legacy.sock'));
    },
  });

  onTestFinished(() => caller.stop());

  expect(
    caller.sendRequest(
      'session.spawn',
      { cwd: '/tmp', resume: `a-${randomUUID()}`, idempotencyKey: 'spawn-4' },
      'gw',
    ),
  ).rejects.toMatchObject({ code: 'outcome_unknown', data: { daemon: 'cloud' } });

  expect(legacy.requests.map((request) => request.m)).toStrictEqual(['daemon.hello']);
});

test('it resends a keyed spawn replay-only, so a resend after the daemon swept the key spawns nothing and answers outcome_unknown', async () => {
  await using daemon = await setupTest();

  const proxy = startCutProxy({
    target: { hostname: '127.0.0.1', port: daemon.port },
    method: 'session.spawn',
    cuts: 1,
    mode: 'close',
  });

  onTestFinished(() => {
    proxy.stop();
  });

  const redialed = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  let opened = 0;

  const caller = new DaemonCaller({
    daemon: {
      name: 'cloud',
      address: { host: '127.0.0.1', port: proxy.port },
      daemonID: daemon.daemonID,
      incarnation: daemon.daemonID.slice(0, 8),
      token: TOKEN,
    },
    build: 'atc-gateway/test',
    openChannel: async (address) => {
      opened++;

      if (opened === 2) {
        redialed.resolve();

        await released.promise;
      }

      return DaemonClient.open({ hostname: address.host, port: address.port });
    },
  });

  onTestFinished(() => caller.stop());

  const spawned = caller.sendRequest(
    'session.spawn',
    { cwd: '/tmp', resume: `a-${randomUUID()}`, idempotencyKey: 'spawn-swept' },
    'gw',
  );

  await redialed.promise;

  const ledger = new Database(daemon.dbPath);

  ledger.run("DELETE FROM idempotency WHERE state = 'completed'");
  ledger.close();
  released.resolve();

  expect(spawned).rejects.toMatchObject({ code: 'outcome_unknown', data: { daemon: 'cloud' } });

  await Promise.allSettled([spawned]);

  const listed = await daemon.owner.sendRequest('session.list');

  expect(proxy.countRequests()).toBe(2);
  expect(listed['sessions']).toHaveLength(1);
});

test('it holds concurrent first requests until the handshake answers, so the daemon never sees a pipelined line', async () => {
  await using daemon = await setupTest();

  const caller = new DaemonCaller({
    daemon: {
      name: 'cloud',
      address: { host: '127.0.0.1', port: daemon.port },
      daemonID: daemon.daemonID,
      incarnation: daemon.daemonID.slice(0, 8),
      token: TOKEN,
    },
    build: 'atc-gateway/test',
    openChannel: (address) => DaemonClient.open({ hostname: address.host, port: address.port }),
  });

  onTestFinished(() => caller.stop());

  const answers = await Promise.all(
    Array.from({ length: 5 }, () => caller.sendRequest('session.list', {}, 'gw')),
  );

  expect(answers).toStrictEqual(Array.from({ length: 5 }, () => ({ sessions: [] })));
});
