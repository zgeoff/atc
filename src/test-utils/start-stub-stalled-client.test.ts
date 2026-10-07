import { expect, onTestFinished, test } from 'bun:test';
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
