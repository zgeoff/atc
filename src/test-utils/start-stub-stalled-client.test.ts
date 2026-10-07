import { expect, test } from 'bun:test';
import { createServer } from 'node:net';
import type { Socket } from 'node:net';
import { join } from 'node:path';
import invariant from 'tiny-invariant';
import { setupTempDir } from './setup-temp-dir';
import { startStubStalledClient } from './start-stub-stalled-client';
import { waitFor } from './wait-for';

/**
 * A temp directory and a unix socket server in it that answers the first
 * line each connection sends with one line of its own, and records each
 * connection it accepts in `peers` and each line it receives in `lines`.
 */
async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const tmp = stack.use(setupTempDir('atc-stub-stalled-client-'));
  const path = join(tmp.dir, 'daemon.sock');
  const peers: Socket[] = [];
  const lines: string[] = [];

  const server = createServer((peer) => {
    peers.push(peer);

    peer.once('data', (data) => {
      lines.push(data.toString());
      peer.write('answer\n');
    });
  });

  const listening = Promise.withResolvers<void>();

  server.listen(path, () => {
    listening.resolve();
  });

  await listening.promise;

  stack.defer(async () => {
    for (const peer of peers) {
      peer.destroy();
    }

    const closed = Promise.withResolvers<void>();

    server.close(() => {
      closed.resolve();
    });

    await closed.promise;
  });

  const owned = stack.move();

  return { path, peers, lines, [Symbol.asyncDispose]: () => owned.disposeAsync() };
}

test('it sends a hello with no auth under the client name it is given', async () => {
  await using ctx = await setupTest();
  using client = await startStubStalledClient(ctx.path, 'atc/stub');

  expect({
    chunks: client.chunks.length,
    lines: ctx.lines.map((line) => JSON.parse(line) as unknown),
  }).toStrictEqual({
    chunks: 1,
    lines: [
      {
        v: expect.toBeNumber(),
        id: 1,
        m: 'daemon.hello',
        p: { client: 'atc/stub', auth: { scheme: 'none' } },
      },
    ],
  });
});

test('it reads nothing after the first chunk though more reaches its connection', async () => {
  await using ctx = await setupTest();
  using client = await startStubStalledClient(ctx.path, 'atc/stub');

  const [peer] = ctx.peers;

  invariant(peer);

  peer.write('more\n');

  await waitFor(() => {
    expect(client.countUnreadBytes()).toBe(5);
  });

  expect(client.chunks).toBeArrayOfSize(1);
});

test('it closes its connection once disposed', async () => {
  await using ctx = await setupTest();

  const client = await startStubStalledClient(ctx.path, 'atc/stub');

  const [peer] = ctx.peers;

  invariant(peer);

  const closed = Promise.withResolvers<void>();

  peer.once('close', () => {
    closed.resolve();
  });

  client[Symbol.dispose]();

  expect(closed.promise).resolves.toBeUndefined();
});
