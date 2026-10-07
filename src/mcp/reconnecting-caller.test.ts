import { expect, onTestFinished, test } from 'bun:test';
import { join } from 'node:path';
import { DaemonClient } from '../client/daemon-client';
import { PROTOCOL_V } from '../protocol/protocol';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { startLegacyDaemon } from '../test-utils/start-legacy-daemon';
import { startStubDroppingDaemon } from '../test-utils/start-stub-dropping-daemon';
import { startTestDaemon } from '../test-utils/start-test-daemon';
import { waitFor } from '../test-utils/wait-for';
import { ReconnectingCaller } from './reconnecting-caller';

async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const daemon = await startTestDaemon({ prefix: 'atc-reconnecting-caller-' });

  stack.use(daemon);

  const caller = new ReconnectingCaller(daemon.socketPath, 'atc/test-build', (path) =>
    DaemonClient.open(path),
  );

  stack.defer(() => caller.stop());

  const owned = stack.move();

  return {
    daemon,
    caller,
    socketPath: daemon.socketPath,
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

test('it answers a read-only request sent right after the daemon restarts', async () => {
  await using ctx = await setupTest();

  await ctx.caller.sendRequest('session.list');
  await ctx.daemon.restart();

  const after = await ctx.caller.sendRequest('session.list');

  expect(after).toStrictEqual({ sessions: [] });
});

test('it closes a connection whose handshake the daemon rejects', async () => {
  using tmp = setupTempDir('atc-reconnecting-caller-');
  using mismatched = startLegacyDaemon(join(tmp.dir, 'daemon.sock'), { protocol: PROTOCOL_V + 1 });

  const caller = new ReconnectingCaller(join(tmp.dir, 'daemon.sock'), 'atc/test-build', (path) =>
    DaemonClient.open(path),
  );

  onTestFinished(() => caller.stop());

  const first = caller.sendRequest('session.list');

  expect(first).rejects.toMatchObject({ code: 'protocol_mismatch' });

  await waitFor(() => {
    expect(mismatched.connections).toStrictEqual({ accepted: 1, open: 0 });
  });
});

test('it opens a fresh connection for the request after one whose handshake the daemon rejected', async () => {
  using tmp = setupTempDir('atc-reconnecting-caller-');
  using mismatched = startLegacyDaemon(join(tmp.dir, 'daemon.sock'), { protocol: PROTOCOL_V + 1 });

  const caller = new ReconnectingCaller(join(tmp.dir, 'daemon.sock'), 'atc/test-build', (path) =>
    DaemonClient.open(path),
  );

  onTestFinished(() => caller.stop());

  await caller.sendRequest('session.list').catch(() => null);

  const second = caller.sendRequest('session.list');

  expect(second).rejects.toMatchObject({ code: 'protocol_mismatch' });
  expect(mismatched.connections.accepted).toBe(2);
});

test('it keeps a connection opened while the one before it was closing', async () => {
  await using ctx = await setupTest();

  await ctx.caller.sendRequest('session.list');

  const stopping = ctx.caller.stop();
  const opening = ctx.caller.sendRequest('session.list');

  await stopping;
  await opening;

  await ctx.caller.sendRequest('session.list');

  // The harness holds one connection of its own beside the caller's.
  await waitFor(() => {
    expect(ctx.daemon.daemon.countClients()).toBe(2);
  });
});

test('it refuses a filtered read unsent when an older daemon replaced the one it handshook with', async () => {
  await using ctx = await setupTest();

  const features = await ctx.caller.readFeatures();

  if (!features.has('events.session')) {
    throw new Error('the first daemon does not announce the session filter');
  }

  await ctx.daemon.stop();

  const legacy = startLegacyDaemon(ctx.socketPath);

  onTestFinished(() => {
    legacy.stop();
  });

  const read = ctx.caller.sendRequest('events.read', { session: 's-1' }, ['events.session']);

  expect(read).rejects.toThrow(/^daemon_outdated: /);
  expect(legacy.requests.map((req) => req.m)).toStrictEqual(['daemon.hello']);
});

test('it retries a spawn on a fresh connection under the key it minted when the connection drops', async () => {
  using tmp = setupTempDir('atc-reconnecting-caller-');

  using dropping = startStubDroppingDaemon(join(tmp.dir, 'daemon.sock'), {
    features: ['spawn.idempotency'],
  });

  const caller = new ReconnectingCaller(join(tmp.dir, 'daemon.sock'), 'atc/test-build', (path) =>
    DaemonClient.open(path),
  );

  onTestFinished(() => caller.stop());

  const ok = await caller.sendRequest('session.spawn', { cwd: '/tmp' });

  expect(ok).toStrictEqual({ session: { id: 's-1' } });
  expect(dropping.keys).toStrictEqual([expect.any(String), dropping.keys[0]]);
});

test('it retries a message on a fresh connection under the key its caller passed', async () => {
  using tmp = setupTempDir('atc-reconnecting-caller-');

  using dropping = startStubDroppingDaemon(join(tmp.dir, 'daemon.sock'), {
    features: ['message.idempotency'],
  });

  const caller = new ReconnectingCaller(join(tmp.dir, 'daemon.sock'), 'atc/test-build', (path) =>
    DaemonClient.open(path),
  );

  onTestFinished(() => caller.stop());

  await caller.sendRequest('session.message', {
    session: 's-1',
    text: 'hi',
    idempotencyKey: 'k-1',
  });

  expect(dropping.keys).toStrictEqual(['k-1', 'k-1']);
});

test('it refuses to retry a keyed spawn unsent when the daemon behind the socket stopped taking keys', () => {
  using tmp = setupTempDir('atc-reconnecting-caller-');

  using dropping = startStubDroppingDaemon(join(tmp.dir, 'daemon.sock'), {
    features: ['spawn.idempotency'],
    retryFeatures: [],
  });

  const caller = new ReconnectingCaller(join(tmp.dir, 'daemon.sock'), 'atc/test-build', (path) =>
    DaemonClient.open(path),
  );

  onTestFinished(() => caller.stop());

  const spawn = caller.sendRequest('session.spawn', { cwd: '/tmp' });

  expect(spawn).rejects.toThrow(/^daemon_outdated: /);
  expect(dropping.keys).toHaveLength(1);
});

test('it fails a spawn whose connection drops when the daemon takes no keys', () => {
  using tmp = setupTempDir('atc-reconnecting-caller-');
  using dropping = startStubDroppingDaemon(join(tmp.dir, 'daemon.sock'), { features: [] });

  const caller = new ReconnectingCaller(join(tmp.dir, 'daemon.sock'), 'atc/test-build', (path) =>
    DaemonClient.open(path),
  );

  onTestFinished(() => caller.stop());

  const spawn = caller.sendRequest('session.spawn', { cwd: '/tmp' });

  expect(spawn).rejects.toMatchObject({ code: 'internal', message: 'connection closed' });
  expect(dropping.keys).toStrictEqual([undefined]);
});
