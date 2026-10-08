import { expect, onTestFinished, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import invariant from 'tiny-invariant';
import { setupTempDir } from './setup-temp-dir';
import { startStubAnsweringListener } from './start-stub-answering-listener';
import { startStubStalledClient } from './start-stub-stalled-client';
import { waitFor } from './wait-for';

// A temp directory and a unix socket server in it that answers the first
// read of each connection with one line and records each connection and that
// first read. Disposal closes the server, then removes the directory.
async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const tmp = stack.use(setupTempDir('atc-stub-stalled-client-'));
  const path = join(tmp.dir, 'daemon.sock');

  const listener = await startStubAnsweringListener(path);

  stack.use(listener);

  const owned = stack.move();

  return {
    path,
    peers: listener.peers,
    lines: listener.lines,
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

test('it sends a hello with no auth under the client name it is given', async () => {
  await using ctx = await setupTest();
  using client = await startStubStalledClient(ctx.path, 'atc/stub');

  expect({
    chunks: client.chunks,
    lines: ctx.lines.map((line) => JSON.parse(line) as unknown),
  }).toStrictEqual({
    chunks: [Buffer.from('answer\n')],
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

  onTestFinished(() => {
    client[Symbol.dispose]();
  });

  const [peer] = ctx.peers;

  invariant(peer);

  const closed = Promise.withResolvers<void>();

  peer.once('close', () => {
    closed.resolve();
  });

  client[Symbol.dispose]();

  expect(closed.promise).resolves.toBeUndefined();
});

test('it closes its connection once the test finishes without a dispose', async () => {
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

  await startStubStalledClient(path, 'atc/stub');

  // The server stops only after this check, so a close it sees comes from
  // the client.
  onTestFinished(async () => {
    await waitFor(() => {
      expect(closes).toStrictEqual(['closed']);
    });
  });

  onTestFinished(() => {
    server.stop(true);
  });
});
