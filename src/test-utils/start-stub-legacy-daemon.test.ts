import { expect, onTestFinished, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import invariant from 'tiny-invariant';
import { DaemonClient } from '../client/daemon-client';
import { setupTempDir } from './setup-temp-dir';
import { startStubLegacyDaemon } from './start-stub-legacy-daemon';
import { waitFor } from './wait-for';

// A temp directory to hold the daemon's socket.
function setupTest() {
  const tmp = setupTempDir('atc-legacy-');

  return {
    socketPath: join(tmp.dir, 'daemon.sock'),
    [Symbol.dispose]: tmp[Symbol.dispose],
  };
}

test('it answers the handshake without a feature list when given none', async () => {
  using ctx = setupTest();

  const daemon = startStubLegacyDaemon(ctx.socketPath);

  onTestFinished(() => {
    daemon.stop();
  });

  const client = await DaemonClient.open(ctx.socketPath);

  onTestFinished(() => {
    client.stop();
  });

  const hello = await client.sendHello('atc/test-build');

  expect(hello).toStrictEqual({
    daemon: 'atc/legacy-build',
    limits: { maxLine: 1_048_576, maxChunk: 65_536 },
    lastUsedAgent: 'claude',
  });
});

test('it announces the features it was given in the handshake', async () => {
  using ctx = setupTest();

  const daemon = startStubLegacyDaemon(ctx.socketPath, {
    features: ['agents.list', 'message.wait'],
  });

  onTestFinished(() => {
    daemon.stop();
  });

  const client = await DaemonClient.open(ctx.socketPath);

  onTestFinished(() => {
    client.stop();
  });

  const hello = await client.sendHello('atc/test-build');

  expect(hello).toStrictEqual({
    daemon: 'atc/legacy-build',
    limits: { maxLine: 1_048_576, maxChunk: 65_536 },
    lastUsedAgent: 'claude',
    features: ['agents.list', 'message.wait'],
  });
});

test('it answers a method with the reply it was given and records the request', async () => {
  using ctx = setupTest();

  using daemon = startStubLegacyDaemon(ctx.socketPath, {
    replies: { 'message.get': { message: 'm-1', status: 'accepted' } },
  });

  const client = await DaemonClient.open(ctx.socketPath);

  onTestFinished(() => {
    client.stop();
  });

  await client.sendHello('atc/test-build');

  const got = await client.sendRequest('message.get', { message: 'm-1', waitMs: 5000 });

  expect(got).toStrictEqual({ message: 'm-1', status: 'accepted' });

  expect(daemon.requests).toStrictEqual([
    { m: 'daemon.hello', p: { client: 'atc/test-build', auth: { scheme: 'none' } } },
    { m: 'message.get', p: { message: 'm-1', waitMs: 5000 } },
  ]);
});

test('it refuses a method it was given no reply for', async () => {
  using ctx = setupTest();

  const daemon = startStubLegacyDaemon(ctx.socketPath, { features: ['agents.list'] });

  onTestFinished(() => {
    daemon.stop();
  });

  const client = await DaemonClient.open(ctx.socketPath);

  onTestFinished(() => {
    client.stop();
  });

  await client.sendHello('atc/test-build');

  expect(client.sendRequest('agents.list')).rejects.toMatchObject({
    code: 'unknown_method',
  });
});

test('it answers a ping without being given a reply', async () => {
  using ctx = setupTest();

  const daemon = startStubLegacyDaemon(ctx.socketPath);

  onTestFinished(() => {
    daemon.stop();
  });

  const client = await DaemonClient.open(ctx.socketPath);

  onTestFinished(() => {
    client.stop();
  });

  await client.sendHello('atc/test-build');

  const pong = await client.sendRequest('daemon.ping');

  expect(pong).toStrictEqual({});
});

test('it refuses a hello on another protocol version with protocol_mismatch', async () => {
  using ctx = setupTest();

  const daemon = startStubLegacyDaemon(ctx.socketPath, { protocol: 3 });

  onTestFinished(() => {
    daemon.stop();
  });

  const client = await DaemonClient.open(ctx.socketPath);

  onTestFinished(() => {
    client.stop();
  });

  expect(client.sendHello('atc/test-build')).rejects.toMatchObject({
    code: 'protocol_mismatch',
    message:
      'atc/test-build speaks protocol v4, daemon atc/legacy-build speaks v3; restart the daemon so both run the same build',
  });
});

test('it counts a connection it accepted as open until the client closes it', async () => {
  using ctx = setupTest();

  const daemon = startStubLegacyDaemon(ctx.socketPath);

  onTestFinished(() => {
    daemon.stop();
  });

  const client = await DaemonClient.open(ctx.socketPath);

  onTestFinished(() => {
    client.stop();
  });

  await client.sendHello('atc/test-build');

  expect(daemon.connections).toStrictEqual({ accepted: 1, open: 1 });
});

test('it counts a connection the client closed as accepted and no longer open', async () => {
  using ctx = setupTest();

  const daemon = startStubLegacyDaemon(ctx.socketPath);

  onTestFinished(() => {
    daemon.stop();
  });

  const client = await DaemonClient.open(ctx.socketPath);

  onTestFinished(() => {
    client.stop();
  });

  await client.sendHello('atc/test-build');

  client.stop();

  await waitFor(() => {
    expect(daemon.connections).toStrictEqual({ accepted: 1, open: 0 });
  });
});

test('it stops listening when disposed', () => {
  using ctx = setupTest();

  const legacy = startStubLegacyDaemon(ctx.socketPath);

  legacy[Symbol.dispose]();

  expect(DaemonClient.open(ctx.socketPath)).rejects.toThrow();
});

test('it answers the handshake on the TCP port it bound when given a TCP address', async () => {
  using daemon = startStubLegacyDaemon({ hostname: '127.0.0.1', port: 0 });

  invariant(daemon.port !== null, 'the daemon bound no TCP port');

  const client = await DaemonClient.open({ hostname: '127.0.0.1', port: daemon.port });

  onTestFinished(() => {
    client.stop();
  });

  const hello = await client.sendHello('atc/test-build');

  expect(hello).toStrictEqual({
    daemon: 'atc/legacy-build',
    limits: { maxLine: 1_048_576, maxChunk: 65_536 },
    lastUsedAgent: 'claude',
  });
});

test('it holds no port when it listens on a unix socket', () => {
  using ctx = setupTest();
  using daemon = startStubLegacyDaemon(ctx.socketPath);

  expect(daemon.port).toBeNull();
});

test('it stops listening once the test finishes without a stop', () => {
  // The socket sits outside any directory the test removes, so only the
  // daemon's own stop takes it away.
  const path = join(tmpdir(), `atc-stub-legacy-${randomUUID()}.sock`);

  startStubLegacyDaemon(path);

  onTestFinished(() => {
    expect(existsSync(path)).toBeFalse();
  });
});

test('it stops once when stopped and disposed before the test finishes', () => {
  const path = join(tmpdir(), `atc-stub-legacy-${randomUUID()}.sock`);
  const daemon = startStubLegacyDaemon(path);

  daemon.stop();
  daemon[Symbol.dispose]();

  expect(existsSync(path)).toBeFalse();
});

test('it leaves a daemon its caller owns listening once the test finishes', () => {
  const path = join(tmpdir(), `atc-stub-legacy-${randomUUID()}.sock`);
  const daemon = startStubLegacyDaemon(path, { owner: 'caller' });

  onTestFinished(() => {
    expect(existsSync(path)).toBeTrue();
  });

  onTestFinished(() => {
    daemon.stop();
  });
});
