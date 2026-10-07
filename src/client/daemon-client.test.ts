import { expect, onTestFinished, test } from 'bun:test';
import { join } from 'node:path';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { startStubClosingListener } from '../test-utils/start-stub-closing-listener';
import { DaemonClient } from './daemon-client';

/**
 * A daemon socket in a fresh temp directory whose listener closes every
 * connection as soon as it opens.
 */
function setupTest() {
  using stack = new DisposableStack();

  const tmp = stack.use(setupTempDir('atc-daemon-client-'));
  const socketPath = join(tmp.dir, 'daemon.sock');

  stack.use(startStubClosingListener(socketPath));

  const owned = stack.move();

  return {
    socketPath,
    [Symbol.dispose]: () => {
      owned.dispose();
    },
  };
}

test('it rejects a request sent after the daemon closed the connection', async () => {
  using ctx = setupTest();

  const client = await DaemonClient.open(ctx.socketPath);

  onTestFinished(() => {
    client.stop();
  });

  const closed = Promise.withResolvers<void>();

  client.onClose = () => {
    closed.resolve();
  };

  await closed.promise;

  expect(client.sendRequest('daemon.ping')).rejects.toMatchObject({
    code: 'internal',
    message: 'connection closed',
  });
});
