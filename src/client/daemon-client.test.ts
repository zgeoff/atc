import { expect, onTestFinished, test } from 'bun:test';
import { join } from 'node:path';
import { setupTempDir } from '../../test/setup-temp-dir';
import { DaemonClient } from './daemon-client';

test('it rejects a request sent after the daemon closed the connection', async () => {
  using tmp = setupTempDir('atc-daemon-client-');

  const socketPath = join(tmp.dir, 'daemon.sock');

  const server = Bun.listen({
    unix: socketPath,
    socket: {
      open(socket) {
        socket.end();
      },
      data() {},
    },
  });

  onTestFinished(() => {
    server.stop(true);
  });

  const client = await DaemonClient.open(socketPath);

  const closed = Promise.withResolvers<void>();

  client.onClose = () => {
    closed.resolve();
  };

  await closed.promise;

  const [outcome] = await Promise.allSettled([client.sendRequest('daemon.ping')]);

  expect(outcome).toMatchObject({
    status: 'rejected',
    reason: { code: 'internal', message: 'connection closed' },
  });
});
