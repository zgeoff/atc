/* oxlint-disable id-length -- `t` and `v` are the relay's frame keys */
import { expect, onTestFinished, test } from 'bun:test';
import { connect } from 'node:net';
import type { Socket } from 'node:net';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { createByteLineSplitter, formatRelayFrame, parseGuestFrame } from '@atc/protocol/relay';
import type { DaemonFrame, ParsedGuestFrame } from '@atc/protocol/relay';
import { waitFor } from '@zgeoff/testing';
import { createTempDir } from '@zgeoff/testing/fs';
import { startRelayMux } from './start-relay-mux';

async function setupTest() {
  const directory = createTempDir('atc-relay-mux-');
  const socketPath = join(directory.path, 'bridge.sock');
  const splitLines = createByteLineSplitter();
  const stdout: ParsedGuestFrame[] = [];

  const encoder = new TextEncoder();

  const mux = await startRelayMux({
    socketPath,
    writeStdout: (text) => {
      for (const line of splitLines(encoder.encode(text))) {
        const frame = parseGuestFrame(line);

        if (frame !== null) {
          stdout.push(frame);
        }
      }
    },
  });

  onTestFinished(async () => {
    await mux.stop();
  });

  const reporters: Socket[] = [];

  return {
    stdout,
    sendFrame: (frame: DaemonFrame) => {
      mux.feed(encoder.encode(formatRelayFrame(frame)));
    },
    connectReporter: async () => {
      const socket = connect(socketPath);
      const received: string[] = [];

      socket.on('error', () => {});
      socket.setEncoding('utf8');

      socket.on('data', (text: string) => {
        received.push(text);
      });

      reporters.push(socket);

      onTestFinished(() => {
        socket.destroy();
      });

      await new Promise<void>((resolve) => {
        socket.once('connect', resolve);
      });

      return { socket, received };
    },
  };
}

test('it accepts a reporter before it reads a byte of stdin, and holds the open frame', async () => {
  const ctx = await setupTest();

  await ctx.connectReporter();

  ctx.sendFrame({ t: 'hello', v: 1, relay: 'r1', gen: 1, ack: 0 });

  await waitFor(() => {
    expect(ctx.stdout).toStrictEqual([
      { t: 'welcome', v: 1, relay: 'r1', gen: 1, ack: 0, reset: true },
      { t: 'open', seq: 1, conn: 1 },
    ]);
  });
});

test('it numbers a reporter line and writes a daemon line to the reporter', async () => {
  const ctx = await setupTest();
  const reporter = await ctx.connectReporter();

  ctx.sendFrame({ t: 'hello', v: 1, relay: 'r1', gen: 1, ack: 0 });
  reporter.socket.write('hook\n');

  await waitFor(() => {
    expect(ctx.stdout).toContainEqual({ t: 'line', seq: 2, conn: 1, line: 'hook' });
  });

  ctx.sendFrame({ t: 'line', seq: 1, conn: 1, line: 'reply' });

  await waitFor(() => {
    expect(reporter.received.join('')).toBe('reply\n');
  });
});

test('it applies each daemon frame once when the daemon sends it twice', async () => {
  const ctx = await setupTest();
  const reporter = await ctx.connectReporter();

  ctx.sendFrame({ t: 'hello', v: 1, relay: 'r1', gen: 1, ack: 0 });
  ctx.sendFrame({ t: 'line', seq: 1, conn: 1, line: 'once' });
  ctx.sendFrame({ t: 'line', seq: 1, conn: 1, line: 'once' });
  ctx.sendFrame({ t: 'line', seq: 2, conn: 1, line: 'next' });

  await waitFor(() => {
    expect(reporter.received.join('')).toBe('once\nnext\n');
  });

  expect(ctx.stdout.at(-1)).toStrictEqual({ t: 'ack', ack: 2 });
});

test('it sends its unacked frames again after a hello that acks none of them', async () => {
  const ctx = await setupTest();
  const reporter = await ctx.connectReporter();

  ctx.sendFrame({ t: 'hello', v: 1, relay: 'r1', gen: 1, ack: 0 });
  reporter.socket.write('hook\n');

  await waitFor(() => {
    expect(ctx.stdout).toContainEqual({ t: 'line', seq: 2, conn: 1, line: 'hook' });
  });

  ctx.stdout.length = 0;

  ctx.sendFrame({ t: 'hello', v: 1, relay: 'r1', gen: 2, ack: 1 });

  await waitFor(() => {
    expect(ctx.stdout).toStrictEqual([
      { t: 'welcome', v: 1, relay: 'r1', gen: 2, ack: 0, reset: false },
      { t: 'line', seq: 2, conn: 1, line: 'hook' },
    ]);
  });
});

test('it closes every bridge connection and renumbers from 1 on a hello of a new relay id', async () => {
  const ctx = await setupTest();
  const reporter = await ctx.connectReporter();

  ctx.sendFrame({ t: 'hello', v: 1, relay: 'r1', gen: 1, ack: 0 });

  await waitFor(() => {
    expect(ctx.stdout).toContainEqual({ t: 'open', seq: 1, conn: 1 });
  });

  const closed = new Promise<void>((resolve) => {
    reporter.socket.once('close', () => {
      resolve();
    });
  });

  ctx.stdout.length = 0;

  ctx.sendFrame({ t: 'hello', v: 1, relay: 'r2', gen: 1, ack: 0 });

  await closed;

  await ctx.connectReporter();

  await waitFor(() => {
    expect(ctx.stdout).toContainEqual({ t: 'open', seq: 1, conn: 2 });
  });

  expect(ctx.stdout[0]).toStrictEqual({
    t: 'welcome',
    v: 1,
    relay: 'r2',
    gen: 1,
    ack: 0,
    reset: true,
  });
});

test('it keeps a closed bridge connection until the daemon acks its close frame', async () => {
  const ctx = await setupTest();
  const reporter = await ctx.connectReporter();

  ctx.sendFrame({ t: 'hello', v: 1, relay: 'r1', gen: 1, ack: 0 });
  reporter.socket.end();
  ctx.sendFrame({ t: 'close', seq: 1, conn: 1 });

  await waitFor(() => {
    expect(ctx.stdout).toContainEqual({ t: 'close', seq: 3, conn: 1 });
  });

  ctx.stdout.length = 0;

  ctx.sendFrame({ t: 'hello', v: 1, relay: 'r1', gen: 2, ack: 2 });

  await waitFor(() => {
    expect(ctx.stdout).toStrictEqual([
      { t: 'welcome', v: 1, relay: 'r1', gen: 2, ack: 1, reset: false },
      { t: 'close', seq: 3, conn: 1 },
    ]);
  });
});

test('it keeps a half-closed reporter connected across a drop until the daemon closes it', async () => {
  const ctx = await setupTest();
  const reporter = await ctx.connectReporter();

  const closed = new Promise<void>((resolve) => {
    reporter.socket.once('close', () => {
      resolve();
    });
  });

  ctx.sendFrame({ t: 'hello', v: 1, relay: 'r1', gen: 1, ack: 0 });
  reporter.socket.write('hook\n');
  reporter.socket.end();

  await waitFor(() => {
    expect(ctx.stdout).toContainEqual({ t: 'end', seq: 3, conn: 1 });
  });

  ctx.sendFrame({ t: 'hello', v: 1, relay: 'r1', gen: 2, ack: 0 });
  ctx.sendFrame({ t: 'line', seq: 1, conn: 1, line: 'reply' });

  await waitFor(() => {
    expect(reporter.received.join('')).toBe('reply\n');
  });

  expect(reporter.socket.destroyed).toBe(false);

  ctx.sendFrame({ t: 'close', seq: 2, conn: 1 });

  await expect(closed).toResolve();
});

test('it takes no new bridge connection while 1 MiB of frames is unacked, until acks free room', async () => {
  const ctx = await setupTest();
  const first = await ctx.connectReporter();

  ctx.sendFrame({ t: 'hello', v: 1, relay: 'r1', gen: 1, ack: 0 });
  first.socket.write(`${'x'.repeat(1024 * 1024)}\n`);

  await waitFor(() => {
    expect(ctx.stdout.some((frame) => frame.t === 'line')).toBe(true);
  });

  await ctx.connectReporter();

  await setImmediate();

  expect(ctx.stdout.filter((frame) => frame.t === 'open')).toHaveLength(1);

  ctx.sendFrame({ t: 'ack', ack: 2 });

  await waitFor(() => {
    expect(ctx.stdout.filter((frame) => frame.t === 'open')).toHaveLength(2);
  });
});
