import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTestCleanup, waitFor } from '@zgeoff/testing';
import { createTempDir } from '@zgeoff/testing/fs';
import invariant from 'tiny-invariant';
import { PROTOCOL_V } from '../wire/index';
import { buildPeerRequestLine } from './build-peer-request-line';
import { startStubAnsweringListener } from './start-stub-answering-listener';
import { startStubStalledClient } from './start-stub-stalled-client';

async function setupTest() {
  const temporaryDirectory = createTempDir('atc-stub-stalled-client-');
  const path = join(temporaryDirectory.path, 'daemon.sock');

  const listener = await startStubAnsweringListener(path);

  return { path, peers: listener.peers, lines: listener.lines };
}

test('it sends a hello with no auth under the client name it is given, then subscribes to events', async () => {
  const ctx = await setupTest();
  const client = await startStubStalledClient(ctx.path, 'atc/stub');

  expect(client.chunks).toStrictEqual([Buffer.from('answer\n')]);

  expect(ctx.lines).toStrictEqual([
    buildPeerRequestLine('1', '/daemon/hello', {
      client: 'atc/stub',
      protocol: PROTOCOL_V,
      auth: { scheme: 'none' },
    }) + buildPeerRequestLine('2', '/events/subscribe', {}),
  ]);
});

test('it reads nothing after the first chunk though more reaches its connection', async () => {
  const ctx = await setupTest();
  const client = await startStubStalledClient(ctx.path, 'atc/stub');

  const [peer] = ctx.peers;

  invariant(peer);

  peer.write('more\n');

  await waitFor(() => {
    expect(client.countUnreadBytes()).toBe(5);
  });

  expect(client.chunks).toBeArrayOfSize(1);
});

test('it closes its connection once stopped', async () => {
  const ctx = await setupTest();
  const client = await startStubStalledClient(ctx.path, 'atc/stub');

  const [peer] = ctx.peers;

  invariant(peer);

  const closed = Promise.withResolvers<void>();

  peer.once('close', () => {
    closed.resolve();
  });

  client.stop();

  expect(closed.promise).resolves.toBeUndefined();
});

test('it closes its connection once the test finishes without a stop', async () => {
  const path = join(tmpdir(), `atc-stub-stalled-client-${randomUUID()}.sock`);

  registerTestCleanup(() => {
    rmSync(path, { force: true });
  });

  const closes: string[] = [];

  const server = Bun.listen({
    unix: path,
    socket: {
      open(socket) {
        socket.write('answer\n');
      },
      data() {},
      close() {
        closes.push('closed');
      },
    },
  });

  registerTestCleanup(() => {
    server.stop(true);
  });

  registerTestCleanup(async () => {
    await waitFor(() => {
      expect(closes).toStrictEqual(['closed']);
    });
  });

  await startStubStalledClient(path, 'atc/stub');
});
