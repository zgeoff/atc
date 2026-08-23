import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OutboundQueue } from './outbound-queue';

interface QueueContext {
  readonly sockPath: string;
  readonly waitForQueue: () => Promise<OutboundQueue>;
}

function setupQueueServer(capacity?: number): QueueContext {
  const dir = mkdtempSync(join(tmpdir(), 'atc-queue-'));
  const sockPath = join(dir, 'q.sock');
  const resolvers = Promise.withResolvers<OutboundQueue>();

  const server = Bun.listen<{ queue: OutboundQueue }>({
    unix: sockPath,
    socket: {
      open(socket) {
        const queue = new OutboundQueue(socket, capacity);

        socket.data = { queue };

        resolvers.resolve(queue);
      },
      drain(socket) {
        socket.data.queue.drain();
      },
      data() {},
      error() {},
    },
  });

  onTestFinished(() => {
    server.stop(true);

    rmSync(dir, { recursive: true, force: true });
  });

  return { sockPath, waitForQueue: () => resolvers.promise };
}

test('it delivers every byte to a slow reader without loss', async () => {
  const ctx = setupQueueServer(8 * 1024 * 1024);
  const client = connect(ctx.sockPath);

  onTestFinished(() => {
    client.destroy();
  });

  client.pause();

  await new Promise<void>((resolve) => {
    client.once('connect', () => {
      resolve();
    });
  });

  const queue = await ctx.waitForQueue();

  const lines: string[] = [];

  for (let i = 0; i < 10_000; i++) {
    lines.push(`{"v":1,"ev":"session.output","s":"s1","seq":${i},"d":"${'x'.repeat(120)}"}\n`);
  }

  for (const line of lines) {
    const accepted = queue.send(line);

    if (!accepted) {
      throw new Error('queue refused a payload below capacity');
    }
  }

  expect(queue.queuedBytes).toBePositive();

  let received = '';

  client.on('data', (chunk: Buffer) => {
    received += chunk.toString('utf8');
  });

  client.resume();

  const expected = lines.join('');
  const deadline = Date.now() + 10_000;

  while (received.length < expected.length && Date.now() < deadline) {
    await Bun.sleep(20);
  }

  expect(received).toBe(expected);
  expect(queue.queuedBytes).toBe(0);
});

test('it refuses a whole payload once the queue is over capacity', async () => {
  const ctx = setupQueueServer(64);
  const client = connect(ctx.sockPath);

  onTestFinished(() => {
    client.destroy();
  });

  client.pause();

  await new Promise<void>((resolve) => {
    client.once('connect', () => {
      resolve();
    });
  });

  const queue = await ctx.waitForQueue();

  // Large enough that the kernel buffer cannot absorb it, so a remainder
  // parks in the queue and pushes it past its 64-byte capacity.
  const first = queue.send('a'.repeat(4 * 1024 * 1024));

  expect(first).toBeTrue();
  expect(queue.queuedBytes).toBeGreaterThan(64);

  const second = queue.send('b');

  expect(second).toBeFalse();
  expect(queue.queuedBytes).toBeGreaterThan(64);
});

test('it preserves payload order across short writes and drains', async () => {
  const ctx = setupQueueServer(8 * 1024 * 1024);
  const client = connect(ctx.sockPath);

  onTestFinished(() => {
    client.destroy();
  });

  client.pause();

  await new Promise<void>((resolve) => {
    client.once('connect', () => {
      resolve();
    });
  });

  const queue = await ctx.waitForQueue();

  for (let i = 0; i < 5000; i++) {
    queue.send(`line-${i}\n`);
  }

  let received = '';

  client.on('data', (chunk: Buffer) => {
    received += chunk.toString('utf8');
  });

  client.resume();

  const deadline = Date.now() + 10_000;

  while (!received.endsWith('line-4999\n') && Date.now() < deadline) {
    await Bun.sleep(20);
  }

  const numbers = received
    .trimEnd()
    .split('\n')
    .map((line) => Number(line.slice('line-'.length)));

  expect(numbers).toStrictEqual(Array.from({ length: 5000 }, (_, i) => i));
});
