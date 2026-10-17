import { expect, mock, test } from 'bun:test';
import { join } from 'node:path';
import { registerTestCleanup, setupTempDir } from '@atc/test-utils';
import { runEvents } from './events';

function setupTest() {
  const tmp = setupTempDir('atc-events-cli-');
  const out: string[] = [];

  return {
    socketPath: join(tmp.dir, 'events.sock'),
    out,
    writeOut: (buf: Buffer) => {
      out.push(buf.toString());
    },
    printError: mock(),
    exit: mock(),
  };
}

test('it exits nonzero with an error line when the daemon closes the stream before it sends an event', async () => {
  const ctx = setupTest();

  const listener = Bun.listen({
    unix: ctx.socketPath,
    socket: {
      open(socket) {
        socket.end();
      },
      data() {},
    },
  });

  registerTestCleanup(() => {
    listener.stop(true);
  });

  await runEvents(ctx);

  expect(ctx.printError).toHaveBeenCalledExactlyOnceWith(
    `atc events: the daemon at ${ctx.socketPath} closed the stream before it sent an event`,
  );

  expect(ctx.exit).toHaveBeenCalledExactlyOnceWith(1);
});

test('it writes the events the daemon sends and exits cleanly when the daemon closes after them', async () => {
  const ctx = setupTest();

  const listener = Bun.listen({
    unix: ctx.socketPath,
    socket: {
      open(socket) {
        socket.write('{"v":4,"ev":"SessionRemoved","s":"s-harbor"}\n');
        socket.end();
      },
      data() {},
    },
  });

  registerTestCleanup(() => {
    listener.stop(true);
  });

  await runEvents(ctx);

  expect(ctx.out.join('')).toBe('{"v":4,"ev":"SessionRemoved","s":"s-harbor"}\n');
  expect(ctx.printError).not.toHaveBeenCalled();
  expect(ctx.exit).not.toHaveBeenCalled();
});

test('it exits nonzero with a hint when no daemon listens', async () => {
  const ctx = setupTest();

  await runEvents(ctx);

  expect(ctx.printError).toHaveBeenCalledExactlyOnceWith(
    `atc events: no daemon at ${ctx.socketPath} — start atc first`,
  );

  expect(ctx.exit).toHaveBeenCalledExactlyOnceWith(1);
});
