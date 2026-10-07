import { expect, onTestFinished, test } from 'bun:test';
import { join } from 'node:path';
import { DaemonClient } from '../client/daemon-client';
import { setupTempDir } from './setup-temp-dir';
import { startLegacyDaemon } from './start-legacy-daemon';

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

  const daemon = startLegacyDaemon(ctx.socketPath);

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

  const daemon = startLegacyDaemon(ctx.socketPath, { features: ['agents.list', 'message.wait'] });

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

  using daemon = startLegacyDaemon(ctx.socketPath, {
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

  const daemon = startLegacyDaemon(ctx.socketPath, { features: ['agents.list'] });

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

  const daemon = startLegacyDaemon(ctx.socketPath);

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

  const daemon = startLegacyDaemon(ctx.socketPath, { protocol: 3 });

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
