import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { registerTestCleanup } from '@atc/test-utils/register-test-cleanup';
import { setupTempDir } from '@atc/test-utils/setup-temp-dir';
import { startStubClosingListener } from '@atc/test-utils/start-stub-closing-listener';
import { startStubTCPDaemon } from '@atc/test-utils/start-stub-tcp-daemon';
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

test('it shows each answer and its method to the answer hook before the request resolves', async () => {
  const daemon = startStubTCPDaemon();

  const client = await DaemonClient.open({ hostname: '127.0.0.1', port: daemon.port });

  registerTestCleanup(() => {
    client.stop();
  });

  const seen: (readonly [string, Readonly<Record<string, unknown>>])[] = [];

  client.onAnswer = (method, ok) => {
    seen.push([method, ok]);
  };

  const answer = await client.sendRequest('session.list');

  expect(seen).toStrictEqual([['session.list', { m: 'session.list' }]]);
  expect(answer).toStrictEqual({ m: 'session.list' });
});

test('it rejects a request whose answer the answer hook throws for', async () => {
  const daemon = startStubTCPDaemon();

  const client = await DaemonClient.open({ hostname: '127.0.0.1', port: daemon.port });

  registerTestCleanup(() => {
    client.stop();
  });

  client.onAnswer = () => {
    throw new Error('outside the contract');
  };

  expect(client.sendRequest('session.list')).rejects.toMatchObject({
    code: 'internal',
    message: 'Error: outside the contract',
  });
});
