import { expect, test } from 'bun:test';
import { connect } from 'node:net';
import { join } from 'node:path';
import type { EventMsg } from '../protocol/protocol';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { subscribeToSocketLines } from '../test-utils/subscribe-to-socket-lines';
import { waitFor } from '../test-utils/wait-for';
import { startEventsServer } from './start-events-server';

// A running events server with one connected subscriber that stopped
// reading; `closed` resolves once that subscriber's connection ends.
// `snapshots` records each snapshot the server collected, which it does
// once it has registered a new subscriber.
async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const tmp = stack.use(setupTempDir('atc-events-server-'));
  const socketPath = join(tmp.dir, 'events.sock');
  const snapshots: (readonly EventMsg[])[] = [];

  const server = startEventsServer({
    socketPath,
    collectSnapshot: () => {
      const snapshot: readonly EventMsg[] = [];

      snapshots.push(snapshot);

      return snapshot;
    },

    // A queue small enough for one burst to overflow it.
    queueBytes: 1024,
  });

  stack.defer(() => {
    server.stop();
  });

  const slow = connect(socketPath);

  stack.defer(() => {
    slow.destroy();
  });

  slow.pause();
  slow.on('error', () => {});

  const closed = Promise.withResolvers<void>();

  slow.on('close', () => {
    closed.resolve();
  });

  await waitFor(() => {
    expect(snapshots).toHaveLength(1);
  });

  const owned = stack.move();

  return {
    server,
    slow,
    socketPath,
    snapshots,
    closed: closed.promise,
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

test('it disconnects a subscriber whose outbound queue overflows', async () => {
  await using ctx = await setupTest();

  // A synchronous burst outruns the subscriber's reads, fills the kernel
  // socket buffers, and then overflows the tiny queue on top of them.
  const big = 'x'.repeat(65_536);

  for (let i = 0; i < 100; i++) {
    ctx.server.broadcast({ v: 4, ev: 'SessionRenamed', s: 'sx', name: big });
  }

  // A paused socket never reads the server's FIN; resuming lets the client
  // observe the disconnect the overflow caused.
  ctx.slow.on('data', () => {});
  ctx.slow.resume();

  await expect(ctx.closed).toResolve();
});

test('it serves a new subscriber after disconnecting one whose queue overflowed', async () => {
  await using ctx = await setupTest();

  // A synchronous burst outruns the subscriber's reads, fills the kernel
  // socket buffers, and then overflows the tiny queue on top of them.
  const big = 'x'.repeat(65_536);

  for (let i = 0; i < 100; i++) {
    ctx.server.broadcast({ v: 4, ev: 'SessionRenamed', s: 'sx', name: big });
  }

  // A paused socket never reads the server's FIN; resuming lets the client
  // observe the disconnect the overflow caused.
  ctx.slow.on('data', () => {});
  ctx.slow.resume();

  await ctx.closed;

  await using fresh = await subscribeToSocketLines(ctx.socketPath);

  await waitFor(() => {
    expect(ctx.snapshots).toHaveLength(2);
  });

  ctx.server.broadcast({ v: 4, ev: 'SessionRemoved', s: 'sx' });

  const lines = await fresh.waitForLine(1);

  expect(lines.map((line) => JSON.parse(line) as unknown)).toStrictEqual([
    { v: 4, ev: 'SessionRemoved', s: 'sx' },
  ]);
});
