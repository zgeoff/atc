import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DaemonClient } from '../client/daemon-client';
import { getRecord } from '../shared/get-record';
import { buildMockAgentAdapter } from '../test-utils/build-mock-agent-adapter';
import { buildMockRegistryDaemon } from '../test-utils/build-mock-registry-daemon';
import { buildStubChannelOpener } from '../test-utils/build-stub-channel-opener';
import { buildStubTimeoutScheduler } from '../test-utils/build-stub-timeout-scheduler';
import { registerTestCleanup } from '../test-utils/register-test-cleanup';
import { startCutProxy } from '../test-utils/start-cut-proxy';
import { startStubLegacyDaemon } from '../test-utils/start-stub-legacy-daemon';
import { startStubUnansweringListener } from '../test-utils/start-stub-unanswering-listener';
import { startTestDaemon } from '../test-utils/start-test-daemon';
import { waitFor } from '../test-utils/wait-for';
import { DaemonCaller } from './daemon-caller';
import type { RegistryDaemon } from './types';

/**
 * A real daemon with a TCP listener on loopback `port` that takes one fixed
 * token. `daemon` is its harness, whose client is the owner's connection on the
 * local socket, and `daemonID` the state identity its handshake returns.
 */
async function setupTest() {
  const daemon = await startTestDaemon({
    prefix: 'atc-daemon-caller-',
    options: (paths) => {
      // The token the listener takes, which every caller here presents.
      writeFileSync(join(paths.dir, 'token'), `${'a'.repeat(32)}\n`);

      return {
        // Takes messages, so a message can end a long poll.
        adapter: buildMockAgentAdapter({ takesMessages: true }),

        // Lets the callers' principal use the local target.
        principals: new Map([['gw', ['local']]]),
        listen: { host: '127.0.0.1', port: 0, tokenFile: join(paths.dir, 'token') },
      };
    },
  });

  const prober = await DaemonClient.open(daemon.socketPath);

  registerTestCleanup(() => {
    prober.stop();
  });

  const hello = await prober.sendHello(daemon.build);

  return {
    daemon,
    port: Number(daemon.daemon.listenPort),
    daemonID: String(hello['daemonID']),
  };
}

test('it answers a request through a daemon whose handshake returns the pinned id', async () => {
  const ctx = await setupTest();

  const caller = new DaemonCaller({
    daemon: buildMockRegistryDaemon({
      name: 'cloud',
      address: { host: '127.0.0.1', port: ctx.port },
      daemonID: ctx.daemonID,
      token: 'a'.repeat(32),
    }),
    build: 'atc-gateway/test',
    openChannel: (address) => DaemonClient.open({ hostname: address.host, port: address.port }),
  });

  registerTestCleanup(() => caller.stop());

  const listed = await caller.sendRequest('session.list', {}, 'gw');

  expect(listed).toStrictEqual({ sessions: [] });
});

test('it reads the build, features, and key retention from the handshake', async () => {
  const ctx = await setupTest();

  const caller = new DaemonCaller({
    daemon: buildMockRegistryDaemon({
      name: 'cloud',
      address: { host: '127.0.0.1', port: ctx.port },
      daemonID: ctx.daemonID,
      token: 'a'.repeat(32),
    }),
    build: 'atc-gateway/test',
    openChannel: (address) => DaemonClient.open({ hostname: address.host, port: address.port }),
  });

  registerTestCleanup(() => caller.stop());

  const hello = await caller.readHello();

  expect(hello).toStrictEqual({
    build: ctx.daemon.build,
    daemonID: ctx.daemonID,
    features: expect.toSatisfy((features: ReadonlySet<string>) => features.has('transport.tcp')),
    retentionMs: 86_400_000,
  });
});

test('it refuses a daemon behind another state identity as daemon_changed and sends it nothing', async () => {
  const ctx = await setupTest();

  const caller = new DaemonCaller({
    daemon: buildMockRegistryDaemon({
      name: 'cloud',
      address: { host: '127.0.0.1', port: ctx.port },
      daemonID: '0f6c2a8e-3d51-4b7a-9c2e-5a8d1e4f7b30',
      token: 'a'.repeat(32),
    }),
    build: 'atc-gateway/test',
    openChannel: (address) => DaemonClient.open({ hostname: address.host, port: address.port }),
  });

  registerTestCleanup(() => caller.stop());

  const spawned = caller.sendRequest(
    'session.spawn',
    { cwd: ctx.daemon.dir, resume: `a-${randomUUID()}` },
    'gw',
  );

  expect(spawned).rejects.toMatchObject({
    code: 'daemon_unavailable',
    data: { daemon: 'cloud', reason: 'daemon_changed' },
  });

  expect(ctx.daemon.client.sendRequest('session.list')).resolves.toStrictEqual({ sessions: [] });
});

test('it refuses a daemon that rejects the token as daemon_unauthorized', async () => {
  const ctx = await setupTest();

  const caller = new DaemonCaller({
    daemon: buildMockRegistryDaemon({
      name: 'cloud',
      address: { host: '127.0.0.1', port: ctx.port },
      daemonID: ctx.daemonID,
      token: 'w'.repeat(32),
    }),
    build: 'atc-gateway/test',
    openChannel: (address) => DaemonClient.open({ hostname: address.host, port: address.port }),
  });

  registerTestCleanup(() => caller.stop());

  expect(caller.sendRequest('session.list', {}, 'gw')).rejects.toMatchObject({
    code: 'daemon_unauthorized',
    data: { daemon: 'cloud' },
  });
});

test('it refuses a daemon nothing listens for as daemon_unavailable', () => {
  const caller = new DaemonCaller({
    daemon: buildMockRegistryDaemon({
      name: 'cloud',

      // Nothing can listen on port 0, so the dial fails at once.
      address: { host: '127.0.0.1', port: 0 },
    }),
    build: 'atc-gateway/test',
    openChannel: (address) => DaemonClient.open({ hostname: address.host, port: address.port }),
  });

  registerTestCleanup(() => caller.stop());

  expect(caller.sendRequest('session.list', {}, 'gw')).rejects.toMatchObject({
    code: 'daemon_unavailable',
    message: "daemon 'cloud' is unreachable",
    data: { daemon: 'cloud' },
  });
});

test("it passes a daemon's own error through with its code", async () => {
  const ctx = await setupTest();

  const caller = new DaemonCaller({
    daemon: buildMockRegistryDaemon({
      name: 'cloud',
      address: { host: '127.0.0.1', port: ctx.port },
      daemonID: ctx.daemonID,
      token: 'a'.repeat(32),
    }),
    build: 'atc-gateway/test',
    openChannel: (address) => DaemonClient.open({ hostname: address.host, port: address.port }),
  });

  registerTestCleanup(() => caller.stop());

  expect(caller.sendRequest('session.get', { session: 'nope' }, 'gw')).rejects.toMatchObject({
    code: 'no_such_session',
    message: "no session 'nope'",
  });
});

test('it retries a keyed spawn whose response was lost once on the same daemon, which spawns once', async () => {
  const ctx = await setupTest();

  const proxy = startCutProxy({
    target: { hostname: '127.0.0.1', port: ctx.port },
    method: 'session.spawn',
    cuts: 1,
    mode: 'close',
  });

  const caller = new DaemonCaller({
    daemon: buildMockRegistryDaemon({
      name: 'cloud',
      address: { host: '127.0.0.1', port: proxy.port },
      daemonID: ctx.daemonID,
      token: 'a'.repeat(32),
    }),
    build: 'atc-gateway/test',
    openChannel: (address) => DaemonClient.open({ hostname: address.host, port: address.port }),
  });

  registerTestCleanup(() => caller.stop());

  const spawned = await caller.sendRequest(
    'session.spawn',
    { cwd: ctx.daemon.dir, resume: `a-${randomUUID()}`, idempotencyKey: 'spawn-1' },
    'gw',
  );

  expect(proxy.countRequests()).toBe(2);

  expect(ctx.daemon.client.sendRequest('session.list')).resolves.toStrictEqual({
    sessions: [expect.objectContaining({ id: getRecord(spawned, 'session')['id'] })],
  });
});

test('it answers outcome_unknown for an unkeyed spawn whose response was lost', async () => {
  const ctx = await setupTest();

  const proxy = startCutProxy({
    target: { hostname: '127.0.0.1', port: ctx.port },
    method: 'session.spawn',
    cuts: 1,
    mode: 'close',
  });

  const caller = new DaemonCaller({
    daemon: buildMockRegistryDaemon({
      name: 'cloud',
      address: { host: '127.0.0.1', port: proxy.port },
      daemonID: ctx.daemonID,
      token: 'a'.repeat(32),
    }),
    build: 'atc-gateway/test',
    openChannel: (address) => DaemonClient.open({ hostname: address.host, port: address.port }),
  });

  registerTestCleanup(() => caller.stop());

  const spawned = caller.sendRequest(
    'session.spawn',
    { cwd: ctx.daemon.dir, resume: `a-${randomUUID()}` },
    'gw',
  );

  expect(spawned).rejects.toMatchObject({ code: 'outcome_unknown', data: { daemon: 'cloud' } });
  expect(proxy.countRequests()).toBe(1);
});

test('it answers outcome_unknown for a keyed spawn whose retry also lost its response', async () => {
  const ctx = await setupTest();

  const proxy = startCutProxy({
    target: { hostname: '127.0.0.1', port: ctx.port },
    method: 'session.spawn',
    cuts: 2,
    mode: 'close',
  });

  const caller = new DaemonCaller({
    daemon: buildMockRegistryDaemon({
      name: 'cloud',
      address: { host: '127.0.0.1', port: proxy.port },
      daemonID: ctx.daemonID,
      token: 'a'.repeat(32),
    }),
    build: 'atc-gateway/test',
    openChannel: (address) => DaemonClient.open({ hostname: address.host, port: address.port }),
  });

  registerTestCleanup(() => caller.stop());

  const spawned = caller.sendRequest(
    'session.spawn',
    { cwd: ctx.daemon.dir, resume: `a-${randomUUID()}`, idempotencyKey: 'spawn-2' },
    'gw',
  );

  expect(spawned).rejects.toMatchObject({ code: 'outcome_unknown', data: { daemon: 'cloud' } });
  expect(proxy.countRequests()).toBe(2);
});

test('it retries a keyed spawn whose response timed out on a fresh connection', async () => {
  const ctx = await setupTest();

  const proxy = startCutProxy({
    target: { hostname: '127.0.0.1', port: ctx.port },
    method: 'session.spawn',
    cuts: 1,
    mode: 'hold',
  });

  const timers = buildStubTimeoutScheduler();

  const opener = buildStubChannelOpener([
    (address: RegistryDaemon['address']) =>
      DaemonClient.open({ hostname: address.host, port: address.port }),
  ]);

  const caller = new DaemonCaller({
    daemon: buildMockRegistryDaemon({
      name: 'cloud',
      address: { host: '127.0.0.1', port: proxy.port },
      daemonID: ctx.daemonID,
      token: 'a'.repeat(32),
    }),
    build: 'atc-gateway/test',
    openChannel: opener.open,
    responseTimeoutMs: 500,
    scheduleTimeout: timers.schedule,
  });

  registerTestCleanup(() => caller.stop());

  const spawning = caller.sendRequest(
    'session.spawn',
    { cwd: ctx.daemon.dir, resume: `a-${randomUUID()}`, idempotencyKey: 'spawn-3' },
    'gw',
  );

  // The daemon has run the spawn whose response the proxy holds, so the
  // retry the timeout sends replays it.
  await waitFor(async () => {
    const listed = await ctx.daemon.client.sendRequest('session.list');

    expect(listed['sessions']).toHaveLength(1);
  });

  timers.runTimer(500);

  const spawned = await spawning;

  expect(ctx.daemon.client.sendRequest('session.list')).resolves.toStrictEqual({
    sessions: [expect.objectContaining({ id: getRecord(spawned, 'session')['id'] })],
  });

  expect(opener.countOpened()).toBe(2);
});

test('it refuses a daemon that never answers the handshake as daemon_unavailable once the connect time passes', () => {
  const silent = startStubUnansweringListener();
  const timers = buildStubTimeoutScheduler();

  const caller = new DaemonCaller({
    daemon: buildMockRegistryDaemon({
      name: 'cloud',
      address: { host: '127.0.0.1', port: silent.port },
    }),
    build: 'atc-gateway/test',
    openChannel: (address) => DaemonClient.open({ hostname: address.host, port: address.port }),
    connectTimeoutMs: 300,
    scheduleTimeout: timers.schedule,
  });

  registerTestCleanup(() => caller.stop());

  const listed = caller.sendRequest('session.list', {}, 'gw');

  timers.runTimer(300);

  expect(listed).rejects.toMatchObject({
    code: 'daemon_unavailable',
    message: "daemon 'cloud' did not answer the connection in time",
  });
});

test('it answers outcome_unknown instead of retrying a keyed spawn on a reconnect that no longer takes keys', async () => {
  const ctx = await setupTest();

  const proxy = startCutProxy({
    target: { hostname: '127.0.0.1', port: ctx.port },
    method: 'session.spawn',
    cuts: 1,
    mode: 'close',
  });

  const legacy = startStubLegacyDaemon(join(ctx.daemon.dir, 'legacy.sock'), {
    features: ['transport.tcp', 'request.principal'],
    replies: {
      'daemon.hello': {
        daemon: 'atc/legacy-build',
        daemonID: ctx.daemonID,
        features: ['transport.tcp'],
      },
    },
  });

  const opener = buildStubChannelOpener([
    (address: RegistryDaemon['address']) =>
      DaemonClient.open({ hostname: address.host, port: address.port }),
    () => DaemonClient.open(join(ctx.daemon.dir, 'legacy.sock')),
  ]);

  const caller = new DaemonCaller({
    daemon: buildMockRegistryDaemon({
      name: 'cloud',
      address: { host: '127.0.0.1', port: proxy.port },
      daemonID: ctx.daemonID,
      token: 'a'.repeat(32),
    }),
    build: 'atc-gateway/test',
    openChannel: opener.open,
  });

  registerTestCleanup(() => caller.stop());

  const spawned = caller.sendRequest(
    'session.spawn',
    { cwd: ctx.daemon.dir, resume: `a-${randomUUID()}`, idempotencyKey: 'spawn-4' },
    'gw',
  );

  expect(spawned).rejects.toMatchObject({ code: 'outcome_unknown', data: { daemon: 'cloud' } });
  expect(legacy.requests.map((request) => request.m)).toStrictEqual(['daemon.hello']);
});

test('it resends a keyed spawn replay-only, so a resend after the daemon swept the key spawns nothing and answers outcome_unknown', async () => {
  const ctx = await setupTest();

  const proxy = startCutProxy({
    target: { hostname: '127.0.0.1', port: ctx.port },
    method: 'session.spawn',
    cuts: 1,
    mode: 'close',
  });

  const opener = buildStubChannelOpener(
    [
      (address: RegistryDaemon['address']) =>
        DaemonClient.open({ hostname: address.host, port: address.port }),
    ],
    { holdDial: 2 },
  );

  const caller = new DaemonCaller({
    daemon: buildMockRegistryDaemon({
      name: 'cloud',
      address: { host: '127.0.0.1', port: proxy.port },
      daemonID: ctx.daemonID,
      token: 'a'.repeat(32),
    }),
    build: 'atc-gateway/test',
    openChannel: opener.open,
  });

  registerTestCleanup(() => caller.stop());

  const spawned = caller.sendRequest(
    'session.spawn',
    { cwd: ctx.daemon.dir, resume: `a-${randomUUID()}`, idempotencyKey: 'spawn-swept' },
    'gw',
  );

  await opener.waitForHeld();

  const ledger = new Database(ctx.daemon.dbPath);

  registerTestCleanup(() => {
    ledger.close();
  });

  // The daemon's sweep drops every completed key once its retention passes.
  ledger.run("DELETE FROM idempotency WHERE state = 'completed'");
  opener.releaseHeld();

  expect(spawned).rejects.toMatchObject({ code: 'outcome_unknown', data: { daemon: 'cloud' } });
  expect(proxy.countRequests()).toBe(2);

  expect(ctx.daemon.client.sendRequest('session.list')).resolves.toStrictEqual({
    sessions: [expect.anything()],
  });
});

test('it holds concurrent first requests until the handshake answers, so the daemon never sees a pipelined line', async () => {
  const ctx = await setupTest();

  const caller = new DaemonCaller({
    daemon: buildMockRegistryDaemon({
      name: 'cloud',
      address: { host: '127.0.0.1', port: ctx.port },
      daemonID: ctx.daemonID,
      token: 'a'.repeat(32),
    }),
    build: 'atc-gateway/test',
    openChannel: (address) => DaemonClient.open({ hostname: address.host, port: address.port }),
  });

  registerTestCleanup(() => caller.stop());

  const answers = await Promise.all(
    Array.from({ length: 5 }, () => caller.sendRequest('session.list', {}, 'gw')),
  );

  expect(answers).toStrictEqual(Array.from({ length: 5 }, () => ({ sessions: [] })));
});

test('it gives a long poll its own waitMs on top of the response time on the same connection', async () => {
  const ctx = await setupTest();

  const timers = buildStubTimeoutScheduler();

  const opener = buildStubChannelOpener([
    (address: RegistryDaemon['address']) =>
      DaemonClient.open({ hostname: address.host, port: address.port }),
  ]);

  const caller = new DaemonCaller({
    daemon: buildMockRegistryDaemon({
      name: 'cloud',
      address: { host: '127.0.0.1', port: ctx.port },
      daemonID: ctx.daemonID,
      token: 'a'.repeat(32),
    }),
    build: 'atc-gateway/test',
    openChannel: opener.open,
    connectTimeoutMs: 10_000,
    responseTimeoutMs: 500,
    scheduleTimeout: timers.schedule,
  });

  registerTestCleanup(() => caller.stop());

  const spawned = await caller.sendRequest(
    'session.spawn',
    { cwd: ctx.daemon.dir, resume: `a-${randomUUID()}` },
    'gw',
  );

  const caughtUp = await caller.sendRequest('events.read', {}, 'gw');

  const waiting = caller.sendRequest(
    'events.read',
    { cursor: caughtUp['cursor'], waitMs: 1500 },
    'gw',
  );

  // Once the poll is out, a message writes the event that ends its wait.
  await waitFor(() => {
    expect(timers.collectPendingDelays()).toStrictEqual([2000]);
  });

  await caller.sendRequest(
    'session.message',
    { session: getRecord(spawned, 'session')['id'], from: 'tester', text: 'wake' },
    'gw',
  );

  const waited = await waiting;

  expect(waited['events']).toStrictEqual([
    expect.objectContaining({
      kind: 'message-accepted',
      session: getRecord(spawned, 'session')['id'],
    }),
  ]);

  expect(timers.collectDelays()).toStrictEqual([10_000, 500, 500, 2000, 500]);
  expect(opener.countOpened()).toBe(1);
});
