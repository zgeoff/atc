import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import invariant from 'tiny-invariant';
import { registerTestCleanup } from './register-test-cleanup';
import { setupTempDir } from './setup-temp-dir';
import { startStubAnsweringListener } from './start-stub-answering-listener';
import { startStubStalledClient } from './start-stub-stalled-client';
import { waitFor } from './wait-for';

// A temp directory and a unix socket server in it that answers the first
// read of each connection with one line and records each connection and that
// first read.
async function setupTest() {
  const tmp = setupTempDir('atc-stub-stalled-client-');
  const path = join(tmp.dir, 'daemon.sock');

  const listener = await startStubAnsweringListener(path);

  return { path, peers: listener.peers, lines: listener.lines };
}

test('it sends a hello with no auth under the client name it is given', async () => {
  const ctx = await setupTest();
  const client = await startStubStalledClient(ctx.path, 'atc/stub');

  expect(client.chunks).toStrictEqual([Buffer.from('answer\n')]);

  expect(ctx.lines.map((line) => JSON.parse(line) as unknown)).toStrictEqual([
    {
      v: expect.toBeNumber(),
      id: 1,
      m: 'daemon.hello',
      p: { client: 'atc/stub', auth: { scheme: 'none' } },
    },
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

  // Releases run last registered first: the client closes, then this check
  // runs, then the server stops, so a close it sees comes from the client.
  registerTestCleanup(async () => {
    await waitFor(() => {
      expect(closes).toStrictEqual(['closed']);
    });
  });

  await startStubStalledClient(path, 'atc/stub');
});
