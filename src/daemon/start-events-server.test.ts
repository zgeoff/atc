import { expect, onTestFinished, test } from 'bun:test';
import { connect } from 'node:net';
import { join } from 'node:path';
import { setupTempDir } from '../../test/setup-temp-dir';
import { subscribeToSocketLines } from '../../test/subscribe-to-socket-lines';
import { waitForCondition } from '../../test/wait-for-condition';
import { startEventsServer } from './start-events-server';
import type { EventsServer } from './start-events-server';

interface ServerFixture {
  readonly server: EventsServer;
  readonly socketPath: string;
  readonly [Symbol.asyncDispose]: () => Promise<void>;
}

function setupTest(queueBytes: number): ServerFixture {
  const tmp = setupTempDir('atc-events-server-');
  const socketPath = join(tmp.dir, 'events.sock');

  const server = startEventsServer({
    socketPath,
    collectSnapshot: () => [],
    queueBytes,
  });

  return {
    server,
    socketPath,
    [Symbol.asyncDispose]: async () => {
      server.stop();

      await tmp[Symbol.asyncDispose]();
    },
  };
}

test('it disconnects a subscriber whose outbound queue overflows and keeps serving new ones', async () => {
  await using setup = setupTest(1024);

  const slow = connect(setup.socketPath);

  slow.pause();
  slow.on('error', () => {});

  let closed = false;

  slow.on('close', () => {
    closed = true;
  });

  onTestFinished(() => {
    slow.destroy();
  });

  await new Promise<void>((resolve) => {
    slow.on('connect', () => {
      resolve();
    });
  });

  // A synchronous burst outruns the subscriber's reads, fills the kernel
  // socket buffers, and then overflows the tiny queue on top of them.
  const big = 'x'.repeat(65_536);

  for (let i = 0; i < 100; i++) {
    setup.server.broadcast({ v: 3, ev: 'SessionRenamed', s: 'sx', name: big });
  }

  // A paused socket never reads the server's FIN; resuming lets the client
  // observe the disconnect the overflow already caused.
  slow.on('data', () => {});
  slow.resume();

  await waitForCondition(() => closed);

  expect(closed).toBeTrue();

  await using fresh = await subscribeToSocketLines(setup.socketPath);

  setup.server.broadcast({ v: 3, ev: 'SessionRemoved', s: 'sx' });

  const lines = await fresh.waitForLine(1);

  expect(lines.map((line) => JSON.parse(line) as unknown)).toStrictEqual([
    { v: 3, ev: 'SessionRemoved', s: 'sx' },
  ]);
});
