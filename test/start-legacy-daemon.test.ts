import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { DaemonClient } from '../src/client/daemon-client';
import { setupTempDir } from './setup-temp-dir';
import { startLegacyDaemon } from './start-legacy-daemon';

async function setupTest(options?: Parameters<typeof startLegacyDaemon>[1]) {
  const tmp = setupTempDir('atc-legacy-');
  const daemon = startLegacyDaemon(join(tmp.dir, 'daemon.sock'), options);

  const client = await DaemonClient.open(join(tmp.dir, 'daemon.sock'));

  return {
    daemon,
    client,
    [Symbol.dispose]() {
      client.stop();
      daemon.stop();
      tmp[Symbol.dispose]();
    },
  };
}

test('it answers the handshake without a feature list when given none', async () => {
  using legacy = await setupTest();

  const hello = await legacy.client.sendHello('atc/test-build');

  expect(hello).toStrictEqual({
    daemon: 'atc/legacy-build',
    limits: { maxLine: 1_048_576, maxChunk: 65_536 },
    lastUsedAgent: 'claude',
  });
});

test('it announces the features it was given in the handshake', async () => {
  using legacy = await setupTest({ features: ['agents.list', 'message.wait'] });

  const hello = await legacy.client.sendHello('atc/test-build');

  expect(hello).toStrictEqual({
    daemon: 'atc/legacy-build',
    limits: { maxLine: 1_048_576, maxChunk: 65_536 },
    lastUsedAgent: 'claude',
    features: ['agents.list', 'message.wait'],
  });
});

test('it answers a method with the reply it was given and records the request', async () => {
  using legacy = await setupTest({
    replies: { 'message.get': { message: 'm-1', status: 'accepted' } },
  });

  await legacy.client.sendHello('atc/test-build');

  const got = await legacy.client.sendRequest('message.get', { message: 'm-1', waitMs: 5000 });

  expect(got).toStrictEqual({ message: 'm-1', status: 'accepted' });

  expect(legacy.daemon.requests).toStrictEqual([
    { m: 'daemon.hello', p: { client: 'atc/test-build', auth: { scheme: 'none' } } },
    { m: 'message.get', p: { message: 'm-1', waitMs: 5000 } },
  ]);
});

test('it refuses a method it was given no reply for', async () => {
  using legacy = await setupTest({ features: ['agents.list'] });

  await legacy.client.sendHello('atc/test-build');

  expect(legacy.client.sendRequest('agents.list')).rejects.toMatchObject({
    code: 'unknown_method',
  });
});

test('it answers a ping without being given a reply', async () => {
  using legacy = await setupTest();

  await legacy.client.sendHello('atc/test-build');

  const pong = await legacy.client.sendRequest('daemon.ping');

  expect(pong).toStrictEqual({});
});

test('it refuses a hello on another protocol version with protocol_mismatch', async () => {
  using legacy = await setupTest({ protocol: 3 });

  expect(legacy.client.sendHello('atc/test-build')).rejects.toMatchObject({
    code: 'protocol_mismatch',
    message:
      'atc/test-build speaks protocol v4, daemon atc/legacy-build speaks v3; restart the daemon so both run the same build',
  });
});
