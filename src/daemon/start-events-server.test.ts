import { expect, test } from 'bun:test';
import { connect } from 'node:net';
import { join } from 'node:path';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { subscribeToSocketLines } from '../test-utils/subscribe-to-socket-lines';
import { startEventsServer } from './start-events-server';

// A running events server with one subscriber that stopped reading and was
// sent more than its queue holds; `closed` resolves once its connection
// ends.
async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const tmp = stack.use(setupTempDir('atc-events-server-'));
  const socketPath = join(tmp.dir, 'events.sock');

  const server = startEventsServer({
    socketPath,
    collectSnapshot: () => [],

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
  const connected = Promise.withResolvers<void>();

  slow.on('close', () => {
    closed.resolve();
  });

  slow.on('connect', () => {
    connected.resolve();
  });

  await connected.promise;

  // A synchronous burst outruns the subscriber's reads, fills the kernel
  // socket buffers, and then overflows the tiny queue on top of them.
  const big = 'x'.repeat(65_536);

  for (let i = 0; i < 100; i++) {
    server.broadcast({ v: 4, ev: 'SessionRenamed', s: 'sx', name: big });
  }

  // A paused socket never reads the server's FIN; resuming lets the client
  // observe the disconnect the overflow already caused.
  slow.on('data', () => {});
  slow.resume();

  const owned = stack.move();

  return {
    server,
    socketPath,
    closed: closed.promise,
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

test('it disconnects a subscriber whose outbound queue overflows', async () => {
  await using ctx = await setupTest();

  await expect(ctx.closed).toResolve();
});

test('it serves a new subscriber after disconnecting one whose queue overflowed', async () => {
  await using ctx = await setupTest();

  await ctx.closed;

  await using fresh = await subscribeToSocketLines(ctx.socketPath);

  ctx.server.broadcast({ v: 4, ev: 'SessionRemoved', s: 'sx' });

  const lines = await fresh.waitForLine(1);

  expect(lines.map((line) => JSON.parse(line) as unknown)).toStrictEqual([
    { v: 4, ev: 'SessionRemoved', s: 'sx' },
  ]);
});
