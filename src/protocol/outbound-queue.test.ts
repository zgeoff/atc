import { expect, test } from 'bun:test';
import { once } from 'node:events';
import { connect } from 'node:net';
import { join } from 'node:path';
import type { Socket } from 'bun';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { waitFor } from '../test-utils/wait-for';
import { OutboundQueue } from './outbound-queue';

// A Unix socket server and a paused client connected to it. The server's
// drain callback flushes whatever queue the test hangs on the socket.
async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const temp = stack.use(setupTempDir('atc-queue-'));
  const opened = Promise.withResolvers<Socket<{ queue: OutboundQueue }>>();

  const server = Bun.listen<{ queue: OutboundQueue }>({
    unix: join(temp.dir, 'q.sock'),
    socket: {
      open(socket) {
        opened.resolve(socket);
      },
      drain(socket) {
        socket.data.queue.drain();
      },
      data() {},
      error() {},
    },
  });

  stack.defer(() => {
    server.stop(true);
  });

  const client = connect(join(temp.dir, 'q.sock'));

  stack.defer(() => {
    client.destroy();
  });

  client.pause();

  await once(client, 'connect');

  const socket = await opened.promise;

  const owned = stack.move();

  return { client, socket, [Symbol.asyncDispose]: () => owned.disposeAsync() };
}

test('it parks what a paused reader cannot take instead of refusing it', async () => {
  await using ctx = await setupTest();

  const queue = new OutboundQueue(ctx.socket, 8 * 1024 * 1024);

  ctx.socket.data = { queue };

  const accepted = Array.from({ length: 10_000 }, (_, i) =>
    queue.send(`{"v":1,"ev":"SessionOutput","s":"s1","seq":${i},"d":"${'x'.repeat(120)}"}\n`),
  );

  expect(accepted).toSatisfyAll((ok: boolean) => ok);
  expect(queue.queuedBytes).toBePositive();
});

test('it delivers every byte to a slow reader without loss', async () => {
  await using ctx = await setupTest();

  const queue = new OutboundQueue(ctx.socket, 8 * 1024 * 1024);

  ctx.socket.data = { queue };

  const lines = Array.from(
    { length: 10_000 },
    (_, i) => `{"v":1,"ev":"SessionOutput","s":"s1","seq":${i},"d":"${'x'.repeat(120)}"}\n`,
  );

  const expected = lines.join('');

  for (const line of lines) {
    queue.send(line);
  }

  let received = '';

  ctx.client.on('data', (chunk: Buffer) => {
    received += chunk.toString('utf8');
  });

  ctx.client.resume();

  await waitFor(
    () => {
      expect(received.length).toBeGreaterThanOrEqual(expected.length);
    },
    { timeoutMs: 4000 },
  );

  expect(received).toBe(expected);
  expect(queue.queuedBytes).toBe(0);
});

test('it queues the unwritten rest of a payload past its capacity', async () => {
  await using ctx = await setupTest();

  const queue = new OutboundQueue(ctx.socket, 64);

  ctx.socket.data = { queue };

  // Large enough that the kernel buffer cannot absorb it, so a remainder
  // parks in the queue and pushes it past its 64-byte capacity.
  const accepted = queue.send('a'.repeat(4 * 1024 * 1024));

  expect(accepted).toBeTrue();
  expect(queue.queuedBytes).toBeGreaterThan(64);
});

test('it refuses a whole payload once the queue is over capacity', async () => {
  await using ctx = await setupTest();

  const queue = new OutboundQueue(ctx.socket, 64);

  ctx.socket.data = { queue };

  // Large enough that the kernel buffer cannot absorb it, so a remainder
  // parks in the queue and pushes it past its 64-byte capacity.
  queue.send('a'.repeat(4 * 1024 * 1024));

  const queuedBefore = queue.queuedBytes;

  // Even one byte more is refused whole once the queue is past capacity.
  const accepted = queue.send('b');

  expect(accepted).toBeFalse();
  expect(queue.queuedBytes).toBe(queuedBefore);
});

test('it preserves payload order across short writes and drains', async () => {
  await using ctx = await setupTest();

  const queue = new OutboundQueue(ctx.socket, 8 * 1024 * 1024);

  ctx.socket.data = { queue };

  const lines = Array.from({ length: 5000 }, (_, i) => `line-${i}\n`);

  for (const line of lines) {
    queue.send(line);
  }

  let received = '';

  ctx.client.on('data', (chunk: Buffer) => {
    received += chunk.toString('utf8');
  });

  ctx.client.resume();

  await waitFor(
    () => {
      expect(received).toEndWith('line-4999\n');
    },
    { timeoutMs: 4000 },
  );

  const numbers = received
    .trimEnd()
    .split('\n')
    .map((line) => Number(line.slice('line-'.length)));

  expect(numbers).toStrictEqual(Array.from({ length: 5000 }, (_, i) => i));
});
