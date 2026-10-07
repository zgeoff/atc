import { expect, onTestFinished, test } from 'bun:test';
import { join } from 'node:path';
import { setupTempDir } from './setup-temp-dir';
import { startStubClosingListener } from './start-stub-closing-listener';

// A temp directory to hold the listener's socket. Disposal removes it.
function setupTest() {
  const tmp = setupTempDir('atc-stub-closing-');

  return { path: join(tmp.dir, 'closing.sock'), [Symbol.dispose]: tmp[Symbol.dispose] };
}

test('it ends a connection as soon as it opens without sending anything', async () => {
  using ctx = setupTest();

  const listener = startStubClosingListener(ctx.path);

  onTestFinished(() => {
    listener[Symbol.dispose]();
  });

  const events: string[] = [];
  const closed = Promise.withResolvers<void>();

  const socket = await Bun.connect({
    unix: ctx.path,
    socket: {
      data(_socket, data) {
        events.push(`data ${data.toString()}`);
      },
      close() {
        events.push('close');
        closed.resolve();
      },
    },
  });

  onTestFinished(() => {
    socket.end();
  });

  await closed.promise;

  expect(events).toStrictEqual(['close']);
});

test('it stops listening once disposed', () => {
  using ctx = setupTest();

  const listener = startStubClosingListener(ctx.path);

  listener[Symbol.dispose]();

  expect(Bun.connect({ unix: ctx.path, socket: { data() {} } })).rejects.toThrow();
});
