import { expect, test } from 'bun:test';
import { connect } from 'node:net';
import { join } from 'node:path';
import { registerTestCleanup } from '@atc/core/test-utils/register-test-cleanup';
import { setupTempDir } from '@atc/core/test-utils/setup-temp-dir';
import { waitFor } from '@atc/core/test-utils/wait-for';
import { subscribeToSocketLines } from '@atc/protocol/test-utils/subscribe-to-socket-lines';
import type { EventMsg } from '@atc/protocol/wire';
import { startEventsServer } from './start-events-server';

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

    queueBytes: 1024,
  });

  registerTestCleanup(() => {
    server.stop();
  });

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

    queueBytes: 1024,
  });

  registerTestCleanup(() => {
    server.stop();
  });

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
