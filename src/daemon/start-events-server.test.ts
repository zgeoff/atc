import { expect, test } from 'bun:test';
import { connect } from 'node:net';
import { join } from 'node:path';
import type { EventMsg } from '../protocol/protocol';
import { registerTestCleanup } from '../test-utils/register-test-cleanup';
import { setupTempDir } from '../test-utils/setup-temp-dir';
import { subscribeToSocketLines } from '../test-utils/subscribe-to-socket-lines';
import { waitFor } from '../test-utils/wait-for';
import { startEventsServer } from './start-events-server';

// A socket path in a fresh temp directory, and a snapshot collector for the
// server under test. `snapshots` records each snapshot the server collected,
// which it does once it has registered a new subscriber.
function setupTest() {
  const tmp = setupTempDir('atc-events-server-');
  const snapshots: (readonly EventMsg[])[] = [];

  return {
    socketPath: join(tmp.dir, 'events.sock'),
    snapshots,
    collectSnapshot: () => {
      const snapshot: readonly EventMsg[] = [];

      snapshots.push(snapshot);

      return snapshot;
    },
  };
}

test('it disconnects a subscriber whose outbound queue overflows', async () => {
  const ctx = setupTest();

  const server = startEventsServer({
    socketPath: ctx.socketPath,
    collectSnapshot: ctx.collectSnapshot,

    // A queue small enough for one burst to overflow it.
    queueBytes: 1024,
  });

  registerTestCleanup(() => {
    server.stop();
  });

  // A subscriber that stopped reading; `closed` resolves once its
  // connection ends.
  const slow = connect(ctx.socketPath);

  registerTestCleanup(() => {
    slow.destroy();
  });

  slow.pause();
  slow.on('error', () => {});

  const closed = Promise.withResolvers<void>();

  slow.on('close', () => {
    closed.resolve();
  });

  await waitFor(() => {
    expect(ctx.snapshots).toHaveLength(1);
  });

  // A synchronous burst outruns the subscriber's reads, fills the kernel
  // socket buffers, and then overflows the tiny queue on top of them.
  const big = 'x'.repeat(65_536);

  for (let i = 0; i < 100; i++) {
    server.broadcast({ v: 4, ev: 'SessionRenamed', s: 'sx', name: big });
  }

  // A paused socket never reads the server's FIN; resuming lets the client
  // observe the disconnect the overflow caused.
  slow.on('data', () => {});
  slow.resume();

  await expect(closed.promise).toResolve();
});

test('it serves a new subscriber after disconnecting one whose queue overflowed', async () => {
  const ctx = setupTest();

  const server = startEventsServer({
    socketPath: ctx.socketPath,
    collectSnapshot: ctx.collectSnapshot,

    // A queue small enough for one burst to overflow it.
    queueBytes: 1024,
  });

  registerTestCleanup(() => {
    server.stop();
  });

  // A subscriber that stopped reading; `closed` resolves once its
  // connection ends.
  const slow = connect(ctx.socketPath);

  registerTestCleanup(() => {
    slow.destroy();
  });

  slow.pause();
  slow.on('error', () => {});

  const closed = Promise.withResolvers<void>();

  slow.on('close', () => {
    closed.resolve();
  });

  await waitFor(() => {
    expect(ctx.snapshots).toHaveLength(1);
  });

  // A synchronous burst outruns the subscriber's reads, fills the kernel
  // socket buffers, and then overflows the tiny queue on top of them.
  const big = 'x'.repeat(65_536);

  for (let i = 0; i < 100; i++) {
    server.broadcast({ v: 4, ev: 'SessionRenamed', s: 'sx', name: big });
  }

  // A paused socket never reads the server's FIN; resuming lets the client
  // observe the disconnect the overflow caused.
  slow.on('data', () => {});
  slow.resume();

  await closed.promise;

  const fresh = await subscribeToSocketLines(ctx.socketPath);

  await waitFor(() => {
    expect(ctx.snapshots).toHaveLength(2);
  });

  server.broadcast({ v: 4, ev: 'SessionRemoved', s: 'sx' });

  const lines = await fresh.waitForLine(1);

  expect(lines.map((line) => JSON.parse(line) as unknown)).toStrictEqual([
    { v: 4, ev: 'SessionRemoved', s: 'sx' },
  ]);
});
