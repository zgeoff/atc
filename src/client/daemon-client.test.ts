import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { registerTestCleanup } from '../test-utils/register-test-cleanup';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { startStubClosingListener } from '../test-utils/start-stub-closing-listener';
import { DaemonClient } from './daemon-client';

/**
 * A daemon socket in a fresh temp directory whose listener closes every
 * connection as soon as it opens.
 */
function setupTest() {
  const tmp = setupTempDir('atc-daemon-client-');
  const socketPath = join(tmp.dir, 'daemon.sock');

  startStubClosingListener(socketPath);

  return { socketPath };
}

test('it rejects a request sent after the daemon closed the connection', async () => {
  const ctx = setupTest();

  const client = await DaemonClient.open(ctx.socketPath);

  registerTestCleanup(() => {
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
