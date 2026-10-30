import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { startTestDaemon } from '@atc/daemon/testing';
import { openDaemonClient } from '@atc/protocol/client';
import { PROTOCOL_V } from '@atc/protocol/wire';
import {
  buildMockAgentAdapter,
  getRecord,
  registerTestCleanup,
  setupTempDir,
  startStubDroppingDaemon,
  startStubLegacyDaemon,
  waitFor,
} from '@atc/test-utils';
import { createTransportCaller } from './create-transport-caller';

async function setupTest() {
  const daemon = await startTestDaemon({ prefix: 'atc-reconnecting-caller-' });

  const caller = createTransportCaller(daemon.socketPath, 'atc/test-build', (path) =>
    openDaemonClient(path),
  );

  registerTestCleanup(() => caller.stop());

  return { daemon, caller, socketPath: daemon.socketPath };
}

test('it resolves a wait for the daemon once the daemon accepts its handshake', async () => {
  const ctx = await setupTest();

  expect(ctx.caller.waitForDaemon()).resolves.toBeUndefined();
});

test('it refuses a wait for the daemon when no daemon listens on the socket', () => {
  const temporaryDirectory = setupTempDir('atc-reconnecting-caller-');

  const caller = createTransportCaller(
    join(temporaryDirectory.path, 'daemon.sock'),
    'atc/test-build',
    (path) => openDaemonClient(path),
  );

  registerTestCleanup(() => caller.stop());

  expect(caller.waitForDaemon()).rejects.toThrow();
});

test('it answers a read-only request sent right after the daemon restarts', async () => {
  const ctx = await setupTest();
  const before = await ctx.caller.sendRequest('session.list');

  const first = ctx.daemon.daemon;

  await ctx.daemon.restart();

  const after = await ctx.caller.sendRequest('session.list');

  expect(before).toStrictEqual({ sessions: [] });
  expect(ctx.daemon.daemon).not.toBe(first);
  expect(after).toStrictEqual({ sessions: [] });
});

test('it closes a connection whose handshake the daemon rejects', async () => {
  const temporaryDirectory = setupTempDir('atc-reconnecting-caller-');

  const mismatched = startStubLegacyDaemon(join(temporaryDirectory.path, 'daemon.sock'), {
    protocol: PROTOCOL_V + 1,
  });

  const caller = createTransportCaller(
    join(temporaryDirectory.path, 'daemon.sock'),
    'atc/test-build',
    (path) => openDaemonClient(path),
  );

  registerTestCleanup(() => caller.stop());

  const first = caller.sendRequest('session.list');

  expect(first).rejects.toMatchObject({ code: 'protocol_mismatch' });

  await waitFor(() => {
    expect(mismatched.connections).toStrictEqual({ accepted: 1, open: 0 });
  });
});

test('it opens a fresh connection for the request after one whose handshake the daemon rejected', async () => {
  const temporaryDirectory = setupTempDir('atc-reconnecting-caller-');

  const mismatched = startStubLegacyDaemon(join(temporaryDirectory.path, 'daemon.sock'), {
    protocol: PROTOCOL_V + 1,
  });

  const caller = createTransportCaller(
    join(temporaryDirectory.path, 'daemon.sock'),
    'atc/test-build',
    (path) => openDaemonClient(path),
  );

  registerTestCleanup(() => caller.stop());

  await caller.sendRequest('session.list').catch(() => null);

  const second = caller.sendRequest('session.list');

  expect(second).rejects.toMatchObject({ code: 'protocol_mismatch' });
  expect(mismatched.connections.accepted).toBe(2);
});

test('it closes its connection and refuses later requests once stopped', async () => {
  const ctx = await setupTest();

  await ctx.caller.sendRequest('session.list');
  await ctx.caller.stop();

  // The harness holds one connection of its own beside the caller's.
  await waitFor(() => {
    expect(ctx.daemon.daemon.countClients()).toBe(1);
  });

  expect(ctx.caller.sendRequest('session.list')).rejects.toThrow('the daemon transport is stopped');
});

test('it retries a spawn on a fresh connection under the key it minted when the connection drops', async () => {
  const temporaryDirectory = setupTempDir('atc-reconnecting-caller-');
  const dropping = startStubDroppingDaemon(join(temporaryDirectory.path, 'daemon.sock'));

  const caller = createTransportCaller(
    join(temporaryDirectory.path, 'daemon.sock'),
    'atc/test-build',
    (path) => openDaemonClient(path),
  );

  registerTestCleanup(() => caller.stop());

  const ok = await caller.sendRequest('session.spawn', { cwd: '/tmp' });

  expect(ok).toStrictEqual({ session: { id: 's-1' } });
  expect(dropping.keys).toStrictEqual([expect.any(String), dropping.keys[0]]);
});

test('it retries a read on a fresh connection as the principal it acts as', async () => {
  const temporaryDirectory = setupTempDir('atc-reconnecting-caller-');
  const dropping = startStubDroppingDaemon(join(temporaryDirectory.path, 'daemon.sock'));

  const caller = createTransportCaller(
    join(temporaryDirectory.path, 'daemon.sock'),
    'atc/test-build',
    (path) => openDaemonClient(path),
  );

  registerTestCleanup(() => caller.stop());

  await caller.sendRequest('session.list', undefined, { id: 'web-panel', name: 'Web panel' });

  expect(dropping.principals).toStrictEqual(['web-panel', 'web-panel']);
});

test('it retries a message on a fresh connection under the key its caller passed', async () => {
  const temporaryDirectory = setupTempDir('atc-reconnecting-caller-');
  const dropping = startStubDroppingDaemon(join(temporaryDirectory.path, 'daemon.sock'));

  const caller = createTransportCaller(
    join(temporaryDirectory.path, 'daemon.sock'),
    'atc/test-build',
    (path) => openDaemonClient(path),
  );

  registerTestCleanup(() => caller.stop());

  await caller.sendRequest('session.message', {
    session: 's-1',
    text: 'hi',
    idempotencyKey: 'k-1',
  });

  expect(dropping.keys).toStrictEqual(['k-1', 'k-1']);
});

test('it resends a keyed spawn unchanged, never as replay-only, so a daemon that never got it runs it', async () => {
  const temporaryDirectory = setupTempDir('atc-reconnecting-caller-');
  const dropping = startStubDroppingDaemon(join(temporaryDirectory.path, 'daemon.sock'));

  const caller = createTransportCaller(
    join(temporaryDirectory.path, 'daemon.sock'),
    'atc/test-build',
    (path) => openDaemonClient(path),
  );

  registerTestCleanup(() => caller.stop());

  const ok = await caller.sendRequest('session.spawn', {
    cwd: '/srv/harbor',
    idempotencyKey: 'k-harbor',
  });

  expect(ok).toStrictEqual({ session: { id: 's-1' } });

  expect(dropping.params).toStrictEqual([
    { cwd: '/srv/harbor', idempotencyKey: 'k-harbor' },
    { cwd: '/srv/harbor', idempotencyKey: 'k-harbor' },
  ]);
});

test('it fails a request that is neither keyed nor read-only when its connection drops', () => {
  const temporaryDirectory = setupTempDir('atc-reconnecting-caller-');
  const dropping = startStubDroppingDaemon(join(temporaryDirectory.path, 'daemon.sock'));

  const caller = createTransportCaller(
    join(temporaryDirectory.path, 'daemon.sock'),
    'atc/test-build',
    (path) => openDaemonClient(path),
  );

  registerTestCleanup(() => caller.stop());

  const kill = caller.sendRequest('session.kill', { session: 's-1' });

  expect(kill).rejects.toMatchObject({ code: 'internal', message: 'connection closed' });
  expect(dropping.keys).toStrictEqual([undefined]);
});

test('it claims the session it was given in the handshake, and none when given null', async () => {
  const daemon = await startTestDaemon({ prefix: 'atc-reconnecting-caller-' });

  const claimed: unknown[] = [];

  const openRecording = async (path: string) => {
    const client = await openDaemonClient(path);

    const sendHello = client.sendHello;

    return Object.assign(client, {
      sendHello: (...args: Parameters<typeof sendHello>) => {
        claimed.push(args[1]?.session);

        return sendHello(...args);
      },
    });
  };

  const inside = createTransportCaller(daemon.socketPath, 'atc/test-build', openRecording, 's-a');
  const outside = createTransportCaller(daemon.socketPath, 'atc/test-build', openRecording, null);

  registerTestCleanup(() => inside.stop());
  registerTestCleanup(() => outside.stop());

  await inside.sendRequest('session.list');
  await outside.sendRequest('session.list');

  expect(claimed).toStrictEqual(['s-a', undefined]);
});

test("it sends a principal's name beside it, which labels the message the request sends", async () => {
  const daemon = await startTestDaemon({
    prefix: 'atc-reconnecting-caller-',
    options: () => ({ adapter: buildMockAgentAdapter({ takesMessages: true }) }),
  });

  // As `atc mcp --http` runs it: a connector has no inbox, so it claims no session.
  const caller = createTransportCaller(
    daemon.socketPath,
    'atc/test-build',
    (path) => openDaemonClient(path),
    null,
  );

  registerTestCleanup(() => caller.stop());

  const spawned = await caller.sendRequest('session.spawn', { cwd: daemon.directory });

  const session = getRecord(spawned, 'session')['id'];

  const sent = await caller.sendRequest(
    'session.message',
    { session, text: 'check the tide tables', from: 'impostor' },
    { id: 'client-7', name: 'Lantern Notes' },
  );

  const got = await caller.sendRequest('message.get', { message: sent['message'] });

  expect(got).toMatchObject({
    from: 'Lantern Notes',
    sender: { kind: 'connector', client: 'client-7', name: 'Lantern Notes' },
  });
});
