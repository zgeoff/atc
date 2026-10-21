import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startTestDaemon } from '@atc/daemon/testing';
import { openDaemonClient } from '@atc/protocol/client';
import {
  buildMockAgentAdapter,
  buildStubChannelOpener,
  buildStubClock,
  getRecord,
  registerTestCleanup,
  startCutProxy,
  startStubUnansweringListener,
  waitFor,
} from '@atc/test-utils';
import { createGatewayDaemonCaller } from './create-gateway-daemon-caller';
import { buildMockRegistryDaemon } from './testing/build-mock-registry-daemon';
import type { RegistryDaemon } from './types';

async function setupTest() {
  const daemon = await startTestDaemon({
    prefix: 'atc-daemon-caller-',
    options: (paths) => {
      // The token the listener takes, which every caller here presents.
      writeFileSync(join(paths.directory, 'token'), `${'a'.repeat(32)}\n`);

      return {
        // Takes messages, so a message can end a long poll.
        adapter: buildMockAgentAdapter({ takesMessages: true }),

        // Lets the callers' principal use the local target.
        principals: new Map([['gw', ['local']]]),
        listen: { host: '127.0.0.1', port: 0, tokenFile: join(paths.directory, 'token') },
      };
    },
  });

  const prober = await openDaemonClient(daemon.socketPath);

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

  const caller = createGatewayDaemonCaller({
    daemon: buildMockRegistryDaemon({
      name: 'cloud',
      address: { host: '127.0.0.1', port: ctx.port },
      daemonID: ctx.daemonID,
      token: 'a'.repeat(32),
    }),
    build: 'atc-gateway/test',
    openChannel: (address) => openDaemonClient({ hostname: address.host, port: address.port }),
  });

  registerTestCleanup(() => caller.stop());

  const listed = await caller.sendRequest('session.list', {}, { id: 'gw', name: 'Lantern Notes' });

  expect(listed).toStrictEqual({ sessions: [] });
});

test('it reads the build and key retention from the handshake', async () => {
  const ctx = await setupTest();

  const caller = createGatewayDaemonCaller({
    daemon: buildMockRegistryDaemon({
      name: 'cloud',
      address: { host: '127.0.0.1', port: ctx.port },
      daemonID: ctx.daemonID,
      token: 'a'.repeat(32),
    }),
    build: 'atc-gateway/test',
    openChannel: (address) => openDaemonClient({ hostname: address.host, port: address.port }),
  });

  registerTestCleanup(() => caller.stop());

  const hello = await caller.readHello();

  expect(hello).toStrictEqual({
    build: ctx.daemon.build,
    daemonID: ctx.daemonID,
    retentionMs: 86_400_000,
  });
});

test('it refuses a daemon behind another state identity as daemon_changed and sends it nothing', async () => {
  const ctx = await setupTest();

  const caller = createGatewayDaemonCaller({
    daemon: buildMockRegistryDaemon({
      name: 'cloud',
      address: { host: '127.0.0.1', port: ctx.port },
      daemonID: '0f6c2a8e-3d51-4b7a-9c2e-5a8d1e4f7b30',
      token: 'a'.repeat(32),
    }),
    build: 'atc-gateway/test',
    openChannel: (address) => openDaemonClient({ hostname: address.host, port: address.port }),
  });

  registerTestCleanup(() => caller.stop());

  const spawned = caller.sendRequest(
    'session.spawn',
    { cwd: ctx.daemon.directory, resume: `a-${randomUUID()}` },
    { id: 'gw', name: 'Lantern Notes' },
  );

  expect(spawned).rejects.toMatchObject({
    code: 'daemon_unavailable',
    data: { daemon: 'cloud', reason: 'daemon_changed' },
  });

  expect(ctx.daemon.client.sendRequest('session.list')).resolves.toStrictEqual({ sessions: [] });
});

test('it refuses a daemon that rejects the token as daemon_unauthorized', async () => {
  const ctx = await setupTest();

  const caller = createGatewayDaemonCaller({
    daemon: buildMockRegistryDaemon({
      name: 'cloud',
      address: { host: '127.0.0.1', port: ctx.port },
      daemonID: ctx.daemonID,
      token: 'w'.repeat(32),
    }),
    build: 'atc-gateway/test',
    openChannel: (address) => openDaemonClient({ hostname: address.host, port: address.port }),
  });

  registerTestCleanup(() => caller.stop());

  expect(
    caller.sendRequest('session.list', {}, { id: 'gw', name: 'Lantern Notes' }),
  ).rejects.toMatchObject({
    code: 'daemon_unauthorized',
    data: { daemon: 'cloud' },
  });
});

test('it refuses a daemon nothing listens for as daemon_unavailable', () => {
  const caller = createGatewayDaemonCaller({
    daemon: buildMockRegistryDaemon({
      name: 'cloud',

      // Nothing can listen on port 0, so the dial fails at once.
      address: { host: '127.0.0.1', port: 0 },
    }),
    build: 'atc-gateway/test',
    openChannel: (address) => openDaemonClient({ hostname: address.host, port: address.port }),
  });

  registerTestCleanup(() => caller.stop());

  expect(
    caller.sendRequest('session.list', {}, { id: 'gw', name: 'Lantern Notes' }),
  ).rejects.toMatchObject({
    code: 'daemon_unavailable',
    message: "daemon 'cloud' is unreachable",
    data: { daemon: 'cloud' },
  });
});

test("it passes a daemon's own error through with its code", async () => {
  const ctx = await setupTest();

  const caller = createGatewayDaemonCaller({
    daemon: buildMockRegistryDaemon({
      name: 'cloud',
      address: { host: '127.0.0.1', port: ctx.port },
      daemonID: ctx.daemonID,
      token: 'a'.repeat(32),
    }),
    build: 'atc-gateway/test',
    openChannel: (address) => openDaemonClient({ hostname: address.host, port: address.port }),
  });

  registerTestCleanup(() => caller.stop());

  expect(
    caller.sendRequest('session.get', { session: 'nope' }, { id: 'gw', name: 'Lantern Notes' }),
  ).rejects.toMatchObject({
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

  const caller = createGatewayDaemonCaller({
    daemon: buildMockRegistryDaemon({
      name: 'cloud',
      address: { host: '127.0.0.1', port: proxy.port },
      daemonID: ctx.daemonID,
      token: 'a'.repeat(32),
    }),
    build: 'atc-gateway/test',
    openChannel: (address) => openDaemonClient({ hostname: address.host, port: address.port }),
  });

  registerTestCleanup(() => caller.stop());

  const spawned = await caller.sendRequest(
    'session.spawn',
    { cwd: ctx.daemon.directory, resume: `a-${randomUUID()}`, idempotencyKey: 'spawn-1' },
    { id: 'gw', name: 'Lantern Notes' },
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

  const caller = createGatewayDaemonCaller({
    daemon: buildMockRegistryDaemon({
      name: 'cloud',
      address: { host: '127.0.0.1', port: proxy.port },
      daemonID: ctx.daemonID,
      token: 'a'.repeat(32),
    }),
    build: 'atc-gateway/test',
    openChannel: (address) => openDaemonClient({ hostname: address.host, port: address.port }),
  });

  registerTestCleanup(() => caller.stop());

  const spawned = caller.sendRequest(
    'session.spawn',
    { cwd: ctx.daemon.directory, resume: `a-${randomUUID()}` },
    { id: 'gw', name: 'Lantern Notes' },
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

  const caller = createGatewayDaemonCaller({
    daemon: buildMockRegistryDaemon({
      name: 'cloud',
      address: { host: '127.0.0.1', port: proxy.port },
      daemonID: ctx.daemonID,
      token: 'a'.repeat(32),
    }),
    build: 'atc-gateway/test',
    openChannel: (address) => openDaemonClient({ hostname: address.host, port: address.port }),
  });

  registerTestCleanup(() => caller.stop());

  const spawned = caller.sendRequest(
    'session.spawn',
    { cwd: ctx.daemon.directory, resume: `a-${randomUUID()}`, idempotencyKey: 'spawn-2' },
    { id: 'gw', name: 'Lantern Notes' },
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

  const clock = buildStubClock(0);

  const opener = buildStubChannelOpener([
    (address: RegistryDaemon['address']) =>
      openDaemonClient({ hostname: address.host, port: address.port }),
  ]);

  const caller = createGatewayDaemonCaller({
    daemon: buildMockRegistryDaemon({
      name: 'cloud',
      address: { host: '127.0.0.1', port: proxy.port },
      daemonID: ctx.daemonID,
      token: 'a'.repeat(32),
    }),
    build: 'atc-gateway/test',
    openChannel: opener.open,
    responseTimeoutMs: 500,
    clock,
  });

  registerTestCleanup(() => caller.stop());

  const spawning = caller.sendRequest(
    'session.spawn',
    { cwd: ctx.daemon.directory, resume: `a-${randomUUID()}`, idempotencyKey: 'spawn-3' },
    { id: 'gw', name: 'Lantern Notes' },
  );

  // The daemon has run the spawn whose response the proxy holds, so the
  // retry the timeout sends replays it.
  await waitFor(async () => {
    const listed = await ctx.daemon.client.sendRequest('session.list');

    expect(listed['sessions']).toHaveLength(1);
  });

  await waitFor(() => {
    expect(clock.collectPending()).toStrictEqual([500]);
  });

  clock.advance(500);

  const spawned = await spawning;

  expect(ctx.daemon.client.sendRequest('session.list')).resolves.toStrictEqual({
    sessions: [expect.objectContaining({ id: getRecord(spawned, 'session')['id'] })],
  });

  expect(opener.countOpened()).toBe(2);
});

test('it refuses a daemon that never answers the handshake as daemon_unavailable once the connect time passes', () => {
  const silent = startStubUnansweringListener();
  const clock = buildStubClock(0);

  const caller = createGatewayDaemonCaller({
    daemon: buildMockRegistryDaemon({
      name: 'cloud',
      address: { host: '127.0.0.1', port: silent.port },
    }),
    build: 'atc-gateway/test',
    openChannel: (address) => openDaemonClient({ hostname: address.host, port: address.port }),
    connectTimeoutMs: 300,
    clock,
  });

  registerTestCleanup(() => caller.stop());

  const listed = caller.sendRequest('session.list', {}, { id: 'gw', name: 'Lantern Notes' });

  expect(clock.collectPending()).toStrictEqual([300]);

  clock.advance(300);

  expect(listed).rejects.toMatchObject({
    code: 'daemon_unavailable',
    message: "daemon 'cloud' did not answer the connection in time",
  });
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
        openDaemonClient({ hostname: address.host, port: address.port }),
    ],
    { holdDial: 2 },
  );

  const caller = createGatewayDaemonCaller({
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
    { cwd: ctx.daemon.directory, resume: `a-${randomUUID()}`, idempotencyKey: 'spawn-swept' },
    { id: 'gw', name: 'Lantern Notes' },
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

  const caller = createGatewayDaemonCaller({
    daemon: buildMockRegistryDaemon({
      name: 'cloud',
      address: { host: '127.0.0.1', port: ctx.port },
      daemonID: ctx.daemonID,
      token: 'a'.repeat(32),
    }),
    build: 'atc-gateway/test',
    openChannel: (address) => openDaemonClient({ hostname: address.host, port: address.port }),
  });

  registerTestCleanup(() => caller.stop());

  const answers = await Promise.all(
    Array.from({ length: 5 }, () =>
      caller.sendRequest('session.list', {}, { id: 'gw', name: 'Lantern Notes' }),
    ),
  );

  expect(answers).toStrictEqual(Array.from({ length: 5 }, () => ({ sessions: [] })));
});

test('it gives a long poll its own waitMs on top of the response time on the same connection', async () => {
  const ctx = await setupTest();

  const clock = buildStubClock(0);

  const opener = buildStubChannelOpener([
    (address: RegistryDaemon['address']) =>
      openDaemonClient({ hostname: address.host, port: address.port }),
  ]);

  const caller = createGatewayDaemonCaller({
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
    clock,
  });

  registerTestCleanup(() => caller.stop());

  const spawned = await caller.sendRequest(
    'session.spawn',
    { cwd: ctx.daemon.directory, resume: `a-${randomUUID()}` },
    { id: 'gw', name: 'Lantern Notes' },
  );

  const caughtUp = await caller.sendRequest('events.read', {}, { id: 'gw', name: 'Lantern Notes' });

  const waiting = caller.sendRequest(
    'events.read',
    { cursor: caughtUp['cursor'], waitMs: 1500 },
    { id: 'gw', name: 'Lantern Notes' },
  );

  // Once the poll is out, a message writes the event that ends its wait.
  await waitFor(() => {
    expect(clock.collectPending()).toStrictEqual([2000]);
  });

  await caller.sendRequest(
    'session.message',
    { session: getRecord(spawned, 'session')['id'], from: 'tester', text: 'wake' },
    { id: 'gw', name: 'Lantern Notes' },
  );

  const waited = await waiting;

  expect(waited['events']).toStrictEqual([
    expect.objectContaining({
      kind: 'message-queued',
      session: getRecord(spawned, 'session')['id'],
    }),
  ]);

  expect(clock.collectDelays()).toStrictEqual([10_000, 500, 500, 2000, 500]);
  expect(opener.countOpened()).toBe(1);
});

test('it sends the name of the principal beside it', async () => {
  const ctx = await setupTest();

  const caller = createGatewayDaemonCaller({
    daemon: buildMockRegistryDaemon({
      name: 'cloud',
      address: { host: '127.0.0.1', port: ctx.port },
      daemonID: ctx.daemonID,
      token: 'a'.repeat(32),
    }),
    build: 'atc-gateway/test',
    openChannel: (address) => openDaemonClient({ hostname: address.host, port: address.port }),
  });

  registerTestCleanup(() => caller.stop());

  const spawned = await ctx.daemon.client.sendRequest('session.spawn', {
    cwd: ctx.daemon.directory,
    resume: `a-${randomUUID()}`,
  });

  const sessionID = getRecord(spawned, 'session')['id'];

  const sent = await caller.sendRequest(
    'session.message',
    { session: sessionID, text: 'check the tide tables', from: 'impostor' },
    { id: 'gw', name: 'Lantern Notes' },
  );

  const got = await ctx.daemon.client.sendRequest('message.get', { message: sent['message'] });

  expect(got).toMatchObject({
    from: 'Lantern Notes',
    sender: { kind: 'connector', client: 'gw', name: 'Lantern Notes' },
  });
});
