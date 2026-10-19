import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { registerTestCleanup } from './register-test-cleanup';
import { setupTempDir } from './setup-temp-dir';
import { startStubLineDaemon } from './start-stub-line-daemon';

function setupTest() {
  const tmp = setupTempDir('atc-stub-line-');

  return { socketPath: join(tmp.dir, 'daemon.sock') };
}

test('it answers a peer handshake with the malformed-line error of protocol v4 and ends the connection', async () => {
  const ctx = setupTest();

  startStubLineDaemon(ctx.socketPath);

  let received = '';
  const ended = Promise.withResolvers<void>();

  const socket = await Bun.connect({
    unix: ctx.socketPath,
    socket: {
      data(_socket, buf) {
        received += new TextDecoder().decode(buf);
      },
      close() {
        ended.resolve();
      },
    },
  });

  registerTestCleanup(() => {
    socket.end();
  });

  socket.write(`${JSON.stringify({ i: '0', p: { u: '/daemon/hello', b: { json: {} } } })}\n`);

  await ended.promise;

  expect(JSON.parse(received)).toStrictEqual({
    v: 4,
    id: 0,
    err: { code: 'bad_args', msg: 'malformed line: missing v' },
  });
});

test('it records each line it reads', async () => {
  const ctx = setupTest();
  const daemon = startStubLineDaemon(ctx.socketPath);
  const ended = Promise.withResolvers<void>();

  const socket = await Bun.connect({
    unix: ctx.socketPath,
    socket: {
      data() {},
      close() {
        ended.resolve();
      },
    },
  });

  registerTestCleanup(() => {
    socket.end();
  });

  socket.write('{"i":"0"}\n');

  await ended.promise;

  expect(daemon.lines).toStrictEqual(['{"i":"0"}']);
});
