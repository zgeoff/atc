import { expect, onTestFinished, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTestCleanup } from './register-test-cleanup';
import { setupTempDir } from './setup-temp-dir';
import { startStubClosingListener } from './start-stub-closing-listener';

// A temp directory to hold the listener's socket, removed once the test
// finishes.
function setupTest() {
  const tmp = setupTempDir('atc-stub-closing-');

  return { path: join(tmp.dir, 'closing.sock') };
}

test('it ends a connection as soon as it opens without sending anything', async () => {
  const ctx = setupTest();

  startStubClosingListener(ctx.path);

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

  registerTestCleanup(() => {
    socket.end();
  });

  await closed.promise;

  expect(events).toStrictEqual(['close']);
});

test('it stops listening once stopped', () => {
  const ctx = setupTest();
  const listener = startStubClosingListener(ctx.path);

  listener.stop();

  expect(Bun.connect({ unix: ctx.path, socket: { data() {} } })).rejects.toThrow();
});

test('it stops listening once the test finishes without a stop', () => {
  // The socket sits outside any directory the test removes, so only the
  // listener's own stop takes it away.
  const path = join(tmpdir(), `atc-stub-closing-${randomUUID()}.sock`);
  let left: boolean | null = null;

  // Runs after the helper's own release, which registers later; it
  // records whether that release left the socket, then removes it.
  registerTestCleanup(() => {
    left = existsSync(path);

    rmSync(path, { force: true });
  });

  startStubClosingListener(path);

  onTestFinished(() => {
    expect(left).toBeFalse();
  });
});
