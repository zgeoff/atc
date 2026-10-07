import { expect, onTestFinished, test } from 'bun:test';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { setupTempDir } from './setup-temp-dir';
import { subscribeToSocketLines } from './subscribe-to-socket-lines';

test('it collects the complete lines a peer sends', async () => {
  await using tmp = setupTempDir('atc-sock-lines-');

  const path = join(tmp.dir, 'lines.sock');

  const server = Bun.listen({
    unix: path,
    socket: {
      open(socket) {
        socket.write('{"a":1}\n{"b"');
      },
      data() {},
      close() {},
      error() {},
    },
  });

  onTestFinished(() => {
    server.stop(true);
  });

  await using subscriber = await subscribeToSocketLines(path);

  expect(subscriber.waitForLine(1)).resolves.toStrictEqual(['{"a":1}']);
});

test('it buffers a split line across reads', async () => {
  await using tmp = setupTempDir('atc-sock-lines-');

  const path = join(tmp.dir, 'lines.sock');

  const server = Bun.listen({
    unix: path,
    socket: {
      open(socket) {
        socket.write('{"a":1}\n{"b"');
      },
      data(socket) {
        socket.write(':2}\n');
      },
      close() {},
      error() {},
    },
  });

  onTestFinished(() => {
    server.stop(true);
  });

  await using subscriber = await subscribeToSocketLines(path);

  await subscriber.waitForLine(1);

  subscriber.write('go\n');

  expect(subscriber.waitForLine(2)).resolves.toStrictEqual(['{"a":1}', '{"b":2}']);
});

test('it sends a payload larger than one socket write whole', async () => {
  await using tmp = setupTempDir('atc-sock-lines-');

  const path = join(tmp.dir, 'big.sock');
  const received: Buffer[] = [];
  const line = 'x'.repeat(3_000_000);

  const server = Bun.listen({
    unix: path,
    socket: {
      data(socket, buf) {
        received.push(Buffer.from(buf));

        if (buf.at(-1) === 10) {
          socket.write(`${Buffer.concat(received).length}\n`);
        }
      },
      close() {},
      error() {},
    },
  });

  onTestFinished(() => {
    server.stop(true);
  });

  await using subscriber = await subscribeToSocketLines(path);

  subscriber.write(`${line}\n`);

  expect(subscriber.waitForLine(1)).resolves.toStrictEqual([String(line.length + 1)]);
});

test('it throws on a write while the unsent bytes fill the queue', async () => {
  await using tmp = setupTempDir('atc-sock-lines-');

  const path = join(tmp.dir, 'stalled.sock');

  // The peer never reads, so what the kernel does not take stays queued.
  const server = createServer((peer) => {
    peer.pause();
  });

  onTestFinished(() => {
    server.close();
  });

  await new Promise<void>((resolve) => {
    server.listen(path, resolve);
  });

  await using subscriber = await subscribeToSocketLines(path, { queueBytes: 1024 });

  subscriber.write(`${'x'.repeat(3_000_000)}\n`);

  expect(() => {
    subscriber.write('y');
  }).toThrowWithMessage(
    Error,
    /^the socket refused a 1-character write: \d+ bytes are still unsent$/,
  );
});

test('it resolves closed once the peer ends the connection', async () => {
  await using tmp = setupTempDir('atc-sock-lines-');

  const path = join(tmp.dir, 'closing.sock');

  const server = Bun.listen({
    unix: path,
    socket: {
      open(socket) {
        socket.end();
      },
      data() {},
      close() {},
      error() {},
    },
  });

  onTestFinished(() => {
    server.stop(true);
  });

  await using subscriber = await subscribeToSocketLines(path);

  await expect(subscriber.closed).toResolve();
});

test('it throws listing the collected lines once the connection closes short of the count', async () => {
  await using tmp = setupTempDir('atc-sock-lines-');

  const path = join(tmp.dir, 'short.sock');

  const server = Bun.listen({
    unix: path,
    socket: {
      open(socket) {
        socket.end('only\n');
      },
      data() {},
      close() {},
      error() {},
    },
  });

  onTestFinished(() => {
    server.stop(true);
  });

  await using subscriber = await subscribeToSocketLines(path);

  expect(subscriber.waitForLine(2, 600_000)).rejects.toThrowWithMessage(
    Error,
    'timed out waiting for 2 lines; got ["only"]',
  );
});
