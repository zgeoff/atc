import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { setupTempDir } from './setup-temp-dir';
import { startStubRecordingListener } from './start-stub-recording-listener';
import { startStubStalledListener } from './start-stub-stalled-listener';
import { subscribeToSocketLines } from './subscribe-to-socket-lines';
import { waitFor } from './wait-for';

// A unix socket server and a subscriber connected to it; `peer` is the
// server's side of that connection, which the test writes through, and
// `received` collects what the subscriber sends. A second server at
// `stalledPath` accepts connections and never reads them.
async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const tmp = stack.use(setupTempDir('atc-sock-lines-'));
  const path = join(tmp.dir, 'lines.sock');
  const listener = stack.use(startStubRecordingListener(path));

  const subscribed = await subscribeToSocketLines(path);

  const subscriber = stack.use(subscribed);

  const peer = await listener.accepted;

  const stalledPath = join(tmp.dir, 'stalled.sock');

  const stalled = await startStubStalledListener(stalledPath);

  stack.use(stalled);

  const owned = stack.move();

  return {
    subscriber,
    peer,
    received: listener.received,
    stalledPath,
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

test('it collects each complete line the socket sends', async () => {
  await using ctx = await setupTest();

  ctx.peer.write('{"a":1}\n{"b":2}\n');

  const lines = await ctx.subscriber.waitForLine(2);

  expect(lines).toStrictEqual(['{"a":1}', '{"b":2}']);
});

test('it buffers a line split across reads until its end arrives', async () => {
  await using ctx = await setupTest();

  ctx.peer.write('{"a":1}\n{"b"');

  await ctx.subscriber.waitForLine(1);

  ctx.peer.write(':2}\n');

  const lines = await ctx.subscriber.waitForLine(2);

  expect(lines).toStrictEqual(['{"a":1}', '{"b":2}']);
});

test('it skips blank lines', async () => {
  await using ctx = await setupTest();

  ctx.peer.write('\n  \n{"a":1}\n');

  const lines = await ctx.subscriber.waitForLine(1);

  expect(lines).toStrictEqual(['{"a":1}']);
});

test('it writes to the socket', async () => {
  await using ctx = await setupTest();

  ctx.subscriber.write('go');

  await waitFor(() => {
    expect(ctx.received.join('')).toBe('go');
  });
});

test('it sends a payload larger than one socket write whole', async () => {
  await using ctx = await setupTest();

  const line = 'x'.repeat(3_000_000);

  ctx.subscriber.write(`${line}\n`);

  await waitFor(() => {
    expect(ctx.received.join('')).toHaveLength(line.length + 1);
  });
});

test('it throws on a write while the unsent bytes fill the queue', async () => {
  await using ctx = await setupTest();
  await using subscriber = await subscribeToSocketLines(ctx.stalledPath, { queueBytes: 1024 });

  subscriber.write(`${'x'.repeat(3_000_000)}\n`);

  expect(() => {
    subscriber.write('y');
  }).toThrowWithMessage(
    Error,
    /^the socket refused a 1-character write: \d+ bytes are still unsent$/,
  );
});

test('it resolves closed once the peer ends the connection', async () => {
  await using ctx = await setupTest();

  ctx.peer.end();

  await expect(ctx.subscriber.closed).toResolve();
});

test('it throws listing the collected lines when the count never arrives', async () => {
  await using ctx = await setupTest();

  ctx.peer.write('{"a":1}\n');

  await ctx.subscriber.waitForLine(1);

  expect(ctx.subscriber.waitForLine(2, 100)).rejects.toThrowWithMessage(
    Error,
    String.raw`timed out waiting for 2 lines; got ["{\"a\":1}"]`,
  );
});

test('it throws listing the collected lines once the connection closes short of the count', async () => {
  await using ctx = await setupTest();

  ctx.peer.end('only\n');

  expect(ctx.subscriber.waitForLine(2, 600_000)).rejects.toThrowWithMessage(
    Error,
    'timed out waiting for 2 lines; got ["only"]',
  );
});
