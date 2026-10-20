import { expect, test } from 'bun:test';
import { connect } from 'node:net';
import { join } from 'node:path';
import type { EventMsg } from '@atc/protocol/wire';
import {
  registerTestCleanup,
  setupTempDir,
  subscribeToSocketLines,
  waitFor,
} from '@atc/test-utils';
import { startEventsServer } from './start-events-server';

// A socket path in a fresh temp directory, and a snapshot collector for the
// server under test. `snapshots` records each snapshot the server collected,
// which it does once it has registered a new subscriber.
function setupTest() {
  const temporaryDirectory = setupTempDir('atc-events-server-');
  const snapshots: (readonly EventMsg[])[] = [];

  return {
    socketPath: join(temporaryDirectory.path, 'events.sock'),
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

  for (let count = 0; count < 100; count++) {
    server.broadcast({ version: 4, ev: 'SessionRenamed', sessionID: 'sx', name: big });
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

  for (let count = 0; count < 100; count++) {
    server.broadcast({ version: 4, ev: 'SessionRenamed', sessionID: 'sx', name: big });
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

  server.broadcast({ version: 4, ev: 'SessionRemoved', sessionID: 'sx' });

  const lines = await fresh.waitForLine(1);

  expect(lines.map((line): unknown => JSON.parse(line))).toStrictEqual([
    { version: 4, ev: 'SessionRemoved', sessionID: 'sx' },
  ]);
});
