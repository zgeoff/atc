import { expect, onTestFinished, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildStubWaitClock } from './build-stub-wait-clock';
import { setupTempDir } from './setup-temp-dir';
import { startStubRecordingListener } from './start-stub-recording-listener';
import { startStubStalledListener } from './start-stub-stalled-listener';
import { subscribeToSocketLines } from './subscribe-to-socket-lines';
import { waitFor } from './wait-for';

// A unix socket server and a subscriber connected to it; `peer` is the
// server's side of that connection, which the test writes through, and
// `received` collects what the subscriber sends. The config's clock, when
// given, is the one the subscriber's line waits read.
async function setupTest(config: Parameters<typeof subscribeToSocketLines>[1] = {}) {
  const tmp = setupTempDir('atc-sock-lines-');
  const path = join(tmp.dir, 'lines.sock');
  const listener = startStubRecordingListener(path);

  const subscriber = await subscribeToSocketLines(path, config);
  const peer = await listener.accepted;

  return { subscriber, peer, received: listener.received };
}

test('it collects each complete line the socket sends', async () => {
  const ctx = await setupTest();

  ctx.peer.write('{"a":1}\n{"b":2}\n');

  const lines = await ctx.subscriber.waitForLine(2);

  expect(lines).toStrictEqual(['{"a":1}', '{"b":2}']);
});

test('it buffers a line split across reads until its end arrives', async () => {
  const ctx = await setupTest();

  ctx.peer.write('{"a":1}\n{"b"');

  await ctx.subscriber.waitForLine(1);

  ctx.peer.write(':2}\n');

  const lines = await ctx.subscriber.waitForLine(2);

  expect(lines).toStrictEqual(['{"a":1}', '{"b":2}']);
});

test('it skips blank lines', async () => {
  const ctx = await setupTest();

  ctx.peer.write('\n  \n{"a":1}\n');

  const lines = await ctx.subscriber.waitForLine(1);

  expect(lines).toStrictEqual(['{"a":1}']);
});

test('it writes to the socket', async () => {
  const ctx = await setupTest();

  ctx.subscriber.write('go');

  await waitFor(() => {
    expect(ctx.received.join('')).toBe('go');
  });
});

test('it sends a payload larger than one socket write whole', async () => {
  const ctx = await setupTest();

  const line = 'x'.repeat(3_000_000);

  ctx.subscriber.write(`${line}\n`);

  await waitFor(() => {
    expect(ctx.received.join('')).toHaveLength(line.length + 1);
  });
});

test('it throws on a write while the unsent bytes fill the queue', async () => {
  // A server that accepts connections and never reads them.
  const tmp = setupTempDir('atc-sock-lines-');
  const stalledPath = join(tmp.dir, 'stalled.sock');

  await startStubStalledListener(stalledPath);

  const subscriber = await subscribeToSocketLines(stalledPath, { queueBytes: 1024 });

  subscriber.write(`${'x'.repeat(3_000_000)}\n`);

  expect(() => {
    subscriber.write('y');
  }).toThrowWithMessage(
    Error,
    /^the socket refused a 1-character write: \d+ bytes are still unsent$/,
  );
});

test('it resolves closed once the peer ends the connection', async () => {
  const ctx = await setupTest();

  ctx.peer.end();

  await expect(ctx.subscriber.closed).toResolve();
});

test('it throws listing the collected lines when the count never arrives', async () => {
  const clock = buildStubWaitClock();

  const ctx = await setupTest({ now: clock.now, wait: clock.wait });

  ctx.peer.write('{"a":1}\n');

  await waitFor(() => {
    expect(ctx.subscriber.lines).toStrictEqual(['{"a":1}']);
  });

  expect(ctx.subscriber.waitForLine(2, 100)).rejects.toThrowWithMessage(
    Error,
    String.raw`timed out waiting for 2 lines; got ["{\"a\":1}"]`,
  );
});

test('it throws listing the collected lines once the connection closes short of the count', async () => {
  const ctx = await setupTest();

  ctx.peer.end('only\n');

  expect(ctx.subscriber.waitForLine(2, 600_000)).rejects.toThrowWithMessage(
    Error,
    'timed out waiting for 2 lines; got ["only"]',
  );
});

test('it ends its connection once the test finishes without a dispose', async () => {
  const path = join(tmpdir(), `atc-sock-lines-${randomUUID()}.sock`);
  const closes: string[] = [];

  const server = Bun.listen({
    unix: path,
    socket: {
      data() {},
      close() {
        closes.push('closed');
      },
    },
  });

  await subscribeToSocketLines(path);

  // The server stops only after this check, so a close it sees comes from
  // the subscriber.
  onTestFinished(async () => {
    await waitFor(() => {
      expect(closes).toStrictEqual(['closed']);
    });
  });

  onTestFinished(() => {
    server.stop(true);
  });
});

test('it ends its connection once disposed', async () => {
  const ctx = await setupTest();

  await ctx.subscriber[Symbol.asyncDispose]();

  expect(ctx.subscriber.closed).resolves.toBeUndefined();
});
