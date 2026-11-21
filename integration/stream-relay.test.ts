import { expect, onTestFinished, test } from 'bun:test';
import { connect } from 'node:net';
import { join } from 'node:path';
import { buildStubClock } from '@atc/core/test-utils/build-stub-clock';
import { openStreamRelay } from '@atc/plugin-api';
import type { HarnessRelay, RelayLink, RelayLinkConnection } from '@atc/plugin-api';
import { startRelayMux } from '@atc/reporters/relay-mux';
import { waitFor } from '@zgeoff/testing';
import { createTempDir } from '@zgeoff/testing/fs';

async function setupTest() {
  const directory = createTempDir('atc-stream-relay-');
  const socketPath = join(directory.path, 'bridge.sock');
  const clock = buildStubClock(0);

  const encoder = new TextEncoder();

  const stdout: Uint8Array[] = [];

  const listeners = new Set<(data: Uint8Array) => void>();

  const mux = await startRelayMux({
    socketPath,
    writeStdout: (text) => {
      const bytes = encoder.encode(text);

      stdout.push(bytes);

      for (const listener of listeners) {
        listener(bytes);
      }
    },
  });

  onTestFinished(async () => {
    await mux.stop();
  });

  const ends: ((end: 'dropped' | 'lost') => void)[] = [];

  const forwards = new Set<(bytes: Uint8Array) => void>();

  const link: RelayLink = {
    open: () => {
      const data: ((bytes: Uint8Array) => void)[] = [];

      const forward = (bytes: Uint8Array) => {
        for (const listener of data) {
          listener(bytes);
        }
      };

      listeners.add(forward);
      forwards.add(forward);

      const connection: RelayLinkConnection = {
        onData: (listener) => {
          data.push(listener);

          for (const chunk of stdout) {
            listener(chunk);
          }
        },
        onEnd: (listener) => {
          ends.push(listener);
        },
        write: (bytes) => {
          mux.feed(bytes);

          return Promise.resolve();
        },
        detach: () => {
          listeners.delete(forward);
        },
      };

      return Promise.resolve(connection);
    },
  };

  const relays: HarnessRelay[] = [];
  const lines: string[] = [];

  const opened = openStreamRelay(
    link,
    (relay) => {
      relays.push(relay);

      relay.onLine((line) => {
        lines.push(line);
      });
    },
    { reconnectDelaysMs: [100], clock },
  );

  onTestFinished(() => {
    opened.stop();
  });

  await opened.listening;

  return {
    clock,
    relays,
    lines,
    drop: () => {
      for (const forward of forwards) {
        listeners.delete(forward);
      }

      forwards.clear();

      for (const listener of ends) {
        listener('dropped');
      }

      ends.length = 0;
    },
    connectReporter: async () => {
      const socket = connect(socketPath);
      const received: string[] = [];

      socket.on('error', () => {});
      socket.setEncoding('utf8');

      socket.on('data', (text: string) => {
        received.push(text);
      });

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

test('it carries each line both ways once and in order across a dropped connection', async () => {
  const ctx = await setupTest();
  const reporter = await ctx.connectReporter();

  reporter.socket.write('up 1\n');

  await waitFor(() => {
    expect(ctx.lines).toStrictEqual(['up 1']);
  });

  ctx.drop();
  reporter.socket.write('up 2\nup 3\n');

  await ctx.relays[0]?.writeLine('down 1');

  ctx.clock.advance(100);

  await waitFor(() => {
    expect(ctx.lines).toStrictEqual(['up 1', 'up 2', 'up 3']);
  });

  await ctx.relays[0]?.writeLine('down 2');

  await waitFor(() => {
    expect(reporter.received.join('')).toBe('down 1\ndown 2\n');
  });
});

test('it closes the reporter when the daemon closes its side of the bridge connection', async () => {
  const ctx = await setupTest();
  const reporter = await ctx.connectReporter();

  await waitFor(() => {
    expect(ctx.relays).toHaveLength(1);
  });

  const closed = new Promise<void>((resolve) => {
    reporter.socket.once('close', () => {
      resolve();
    });
  });

  ctx.relays[0]?.close();

  await closed;
});
