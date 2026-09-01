import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startEventsServer } from './start-events-server';
import type { EventsServer } from './start-events-server';

function setupServer(queueBytes: number): { server: EventsServer; socketPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'atc-events-server-'));
  const socketPath = join(dir, 'events.sock');

  const server = startEventsServer({
    socketPath,
    collectSnapshot: () => [],
    queueBytes,
  });

  onTestFinished(() => {
    server.stop();

    rmSync(dir, { recursive: true, force: true });
  });

  return { server, socketPath };
}

test('it disconnects a subscriber whose outbound queue overflows and keeps serving new ones', async () => {
  const setup = setupServer(1024);
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

  await waitFor(() => closed);

  expect(closed).toBeTrue();

  const lines: string[] = [];

  const fresh = await Bun.connect({
    unix: setup.socketPath,
    socket: {
      data(_s, buf) {
        lines.push(
          ...buf
            .toString()
            .split('\n')
            .filter((line) => line.trim() !== ''),
        );
      },
      close() {},
      error() {},
    },
  });

  onTestFinished(() => {
    fresh.end();
  });

  setup.server.broadcast({ v: 3, ev: 'SessionRemoved', s: 'sx' });

  await waitFor(() => lines.length > 0);

  expect(lines.map((line) => JSON.parse(line) as unknown)).toStrictEqual([
    { v: 3, ev: 'SessionRemoved', s: 'sx' },
  ]);
});

async function waitFor(isDone: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;

  while (!isDone() && Date.now() < deadline) {
    await Bun.sleep(10);
  }
}
