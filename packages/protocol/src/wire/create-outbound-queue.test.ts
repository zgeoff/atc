import { expect, test } from 'bun:test';
import { once } from 'node:events';
import { connect } from 'node:net';
import { join } from 'node:path';
import { registerTestCleanup, setupTempDir, waitFor } from '@atc/test-utils';
import type { Socket } from 'bun';
import { createOutboundQueue } from './create-outbound-queue';
import type { OutboundQueue } from './create-outbound-queue';

// A Unix socket server and a paused client connected to it. The server's
// drain callback flushes whatever queue the test hangs on the socket.
async function setupTest() {
  const temp = setupTempDir('atc-queue-');
  const opened = Promise.withResolvers<Socket<{ queue: OutboundQueue }>>();

  const server = Bun.listen<{ queue: OutboundQueue }>({
    unix: join(temp.path, 'q.sock'),
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

  registerTestCleanup(() => {
    server.stop(true);
  });

  const client = connect(join(temp.path, 'q.sock'));

  registerTestCleanup(() => {
    client.destroy();
  });

  client.pause();

  await once(client, 'connect');

  const socket = await opened.promise;

  return { client, socket };
}

test('it parks what a paused reader cannot take instead of refusing it', async () => {
  const ctx = await setupTest();

  const queue = createOutboundQueue(ctx.socket, 8 * 1024 * 1024);

  ctx.socket.data = { queue };

  const accepted = Array.from({ length: 10_000 }, (_, index) =>
    queue.send(
      `{"version":1,"ev":"SessionOutput","sessionID":"s1","seq":${index},"data":"${'x'.repeat(120)}"}\n`,
    ),
  );

  expect(accepted).toSatisfyAll((ok: boolean) => ok);
  expect(queue.queuedBytes).toBePositive();
});

test('it delivers every byte to a slow reader without loss', async () => {
  const ctx = await setupTest();

  const queue = createOutboundQueue(ctx.socket, 8 * 1024 * 1024);

  ctx.socket.data = { queue };

  const lines = Array.from(
    { length: 10_000 },
    (_, index) =>
      `{"version":1,"ev":"SessionOutput","sessionID":"s1","seq":${index},"data":"${'x'.repeat(120)}"}\n`,
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
  const ctx = await setupTest();

  const queue = createOutboundQueue(ctx.socket, 64);

  ctx.socket.data = { queue };

  // Large enough that the kernel buffer cannot absorb it, so a remainder
  // parks in the queue and pushes it past its 64-byte capacity.
  const accepted = queue.send('a'.repeat(4 * 1024 * 1024));

  expect(accepted).toBeTrue();
  expect(queue.queuedBytes).toBeGreaterThan(64);
});

test('it refuses a whole payload once the queue is over capacity', async () => {
  const ctx = await setupTest();

  const queue = createOutboundQueue(ctx.socket, 64);

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
  const ctx = await setupTest();

  const queue = createOutboundQueue(ctx.socket, 8 * 1024 * 1024);

  ctx.socket.data = { queue };

  const lines = Array.from({ length: 5000 }, (_, index) => `line-${index}\n`);

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

  expect(numbers).toStrictEqual(Array.from({ length: 5000 }, (_, index) => index));
});
