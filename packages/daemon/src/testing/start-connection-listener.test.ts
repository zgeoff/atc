import { expect, onTestFinished, test } from 'bun:test';
import { join } from 'node:path';
import { openDaemonClient } from '@atc/protocol/client';
import { setupTempDir } from '@atc/test-utils';
import { buildStubDaemonContext } from './build-stub-daemon-context';
import { startConnectionListener } from './start-connection-listener';

test('it serves a connection that answers a client on the socket', async () => {
  const temporaryDirectory = setupTempDir('atc-connection-listener-');
  const socketPath = join(temporaryDirectory.path, 'daemon.sock');
  const connections = startConnectionListener(socketPath, buildStubDaemonContext());

  const client = await openDaemonClient(socketPath);
  const hello = await client.sendHello('atc/test');

  client.stop();

  expect(hello).toMatchObject({ daemon: 'atc/test', daemonID: 'd-1' });
  expect(connections).toHaveLength(1);
});

test('it checks a handshake as a TCP connection when given a TCP peer', async () => {
  const temporaryDirectory = setupTempDir('atc-connection-listener-');
  const socketPath = join(temporaryDirectory.path, 'daemon.sock');

  startConnectionListener(socketPath, buildStubDaemonContext(), {
    verifyHandshake: () => Promise.resolve(null),
    recordFailure: () => {},
    recordRefusedPrincipal: () => {},
  });

  const client = await openDaemonClient(socketPath);

  onTestFinished(() => {
    client.stop();
  });

  expect(client.sendHello('atc/test', { token: 'tok-wrong' })).rejects.toMatchObject({
    code: 'unauthorized',
    message: 'daemon.hello over TCP needs a valid bearer token',
  });
});
