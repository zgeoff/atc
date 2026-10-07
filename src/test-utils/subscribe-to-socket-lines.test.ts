import { expect, onTestFinished, test } from 'bun:test';
import { join } from 'node:path';
import { setupTempDir } from './setup-temp-dir';
import { subscribeToSocketLines } from './subscribe-to-socket-lines';

test('it collects complete lines and buffers a split line across reads', async () => {
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

  const first = await subscriber.waitForLine(1);

  expect(first).toStrictEqual(['{"a":1}']);

  subscriber.write('go');

  const both = await subscriber.waitForLine(2);

  expect(both).toStrictEqual(['{"a":1}', '{"b":2}']);
});

test('it throws listing the collected lines when the count never arrives', async () => {
  await using tmp = setupTempDir('atc-sock-lines-');

  const path = join(tmp.dir, 'silent.sock');

  const server = Bun.listen({
    unix: path,
    socket: {
      open() {},
      data() {},
      close() {},
      error() {},
    },
  });

  onTestFinished(() => {
    server.stop(true);
  });

  await using subscriber = await subscribeToSocketLines(path);

  expect(subscriber.waitForLine(1, 100)).rejects.toThrowWithMessage(
    Error,
    'timed out waiting for 1 lines; got []',
  );
});
