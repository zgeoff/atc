import { expect, onTestFinished, test } from 'bun:test';
import { join } from 'node:path';
import { DaemonClient } from '../client/daemon-client';
import { setupTempDir } from './setup-temp-dir';
import { startStubDroppingDaemon } from './start-stub-dropping-daemon';

function setupTest() {
  using stack = new DisposableStack();

  const tmp = stack.use(setupTempDir('atc-dropping-daemon-'));
  const socketPath = join(tmp.dir, 'daemon.sock');

  const daemon = startStubDroppingDaemon(socketPath, {
    features: ['spawn.idempotency'],
    retryFeatures: [],
  });

  stack.defer(() => {
    daemon.stop();
  });

  const owned = stack.move();

  return {
    socketPath,
    daemon,
    [Symbol.dispose]: () => {
      owned.dispose();
    },
  };
}

test('it announces the first features on the first handshake', async () => {
  using ctx = setupTest();

  const client = await DaemonClient.open(ctx.socketPath);

  onTestFinished(() => {
    client.stop();
  });

  expect(client.sendHello('atc/test-build')).resolves.toStrictEqual({
    features: ['spawn.idempotency'],
  });
});

test('it announces the retry features on a later handshake', async () => {
  using ctx = setupTest();

  const first = await DaemonClient.open(ctx.socketPath);

  onTestFinished(() => {
    first.stop();
  });

  await first.sendHello('atc/test-build');

  const second = await DaemonClient.open(ctx.socketPath);

  onTestFinished(() => {
    second.stop();
  });

  expect(second.sendHello('atc/test-build')).resolves.toStrictEqual({ features: [] });
});

test('it drops the connection of the first request without answering it', async () => {
  using ctx = setupTest();

  const client = await DaemonClient.open(ctx.socketPath);

  onTestFinished(() => {
    client.stop();
  });

  await client.sendHello('atc/test-build');

  expect(client.sendRequest('session.spawn', { idempotencyKey: 'k-1' })).rejects.toMatchObject({
    code: 'internal',
    message: 'connection closed',
  });
});

test('it answers a later request with a session and records each request key', async () => {
  using ctx = setupTest();

  const first = await DaemonClient.open(ctx.socketPath);

  onTestFinished(() => {
    first.stop();
  });

  await first.sendHello('atc/test-build');
  await first.sendRequest('session.spawn', { idempotencyKey: 'k-1' }).catch(() => null);

  const second = await DaemonClient.open(ctx.socketPath);

  onTestFinished(() => {
    second.stop();
  });

  await second.sendHello('atc/test-build');

  const answered = await second.sendRequest('session.spawn', {});

  expect(answered).toStrictEqual({ session: { id: 's-1' } });
  expect(ctx.daemon.keys).toStrictEqual(['k-1', undefined]);
});

test('it stops listening when disposed', () => {
  using tmp = setupTempDir('atc-dropping-daemon-');

  const dropping = startStubDroppingDaemon(join(tmp.dir, 'daemon.sock'), { features: [] });

  dropping[Symbol.dispose]();

  expect(DaemonClient.open(join(tmp.dir, 'daemon.sock'))).rejects.toThrow();
});
