import { expect, onTestFinished, test } from 'bun:test';
import { join } from 'node:path';
import { DaemonClient } from '../src/client/daemon-client';
import { setupTempDir } from './setup-temp-dir';
import { startLegacyDaemon } from './start-legacy-daemon';

async function setupTest() {
  const tmp = setupTempDir('atc-legacy-');
  const daemon = startLegacyDaemon(join(tmp.dir, 'daemon.sock'));

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

test('it answers the handshake without a feature list', async () => {
  using legacy = await setupTest();

  const hello = await legacy.client.sendHello('atc/test-build');

  expect(hello).toStrictEqual({
    daemon: 'atc/legacy-build',
    limits: { maxLine: 1_048_576, maxChunk: 65_536 },
    lastUsedAgent: 'claude',
  });
});

test('it answers a message read in the older shape and records the options it ignored', async () => {
  using legacy = await setupTest();

  await legacy.client.sendHello('atc/test-build');

  const got = await legacy.client.sendRequest('message.get', { message: 'm-1', waitMs: 5000 });

  expect(got).not.toContainKeys(['turn', 'answeredWith']);

  expect(legacy.daemon.requests).toStrictEqual([
    { m: 'daemon.hello', p: { client: 'atc/test-build', auth: { scheme: 'none' } } },
    { m: 'message.get', p: { message: 'm-1', waitMs: 5000 } },
  ]);
});

test('it refuses a method the older release lacks', async () => {
  using legacy = await setupTest();

  await legacy.client.sendHello('atc/test-build');

  expect(legacy.client.sendRequest('agents.list')).rejects.toMatchObject({
    code: 'unknown_method',
  });
});

test('it lists agents without spawn options in the release before spawn options', async () => {
  using tmp = setupTempDir('atc-legacy-');

  const daemon = startLegacyDaemon(join(tmp.dir, 'daemon.sock'), 'pre-spawn-options');

  const client = await DaemonClient.open(join(tmp.dir, 'daemon.sock'));

  onTestFinished(() => {
    client.stop();
    daemon.stop();
  });

  const hello = await client.sendHello('atc/test-build');
  const listed = await client.sendRequest('agents.list');

  expect(hello['features']).toStrictEqual([
    'agents.list',
    'events.more',
    'events.session',
    'message.turn',
    'message.wait',
  ]);

  expect(listed['agents']).toSatisfyAll(
    (agent: Readonly<Record<string, unknown>>) => !('spawnOptions' in agent),
  );
});
