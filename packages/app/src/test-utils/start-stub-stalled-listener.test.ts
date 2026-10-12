import { expect, onTestFinished, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTestCleanup } from './register-test-cleanup';
import { setupTempDir } from './setup-temp-dir';
import { startStubStalledListener } from './start-stub-stalled-listener';

// A temp directory to hold the listener's socket.
function setupTest() {
  const tmp = setupTempDir('atc-stub-stalled-');

  return { path: join(tmp.dir, 'stalled.sock') };
}

test('it accepts a connection and leaves a large write to it partly unsent', async () => {
  const ctx = setupTest();

  await startStubStalledListener(ctx.path);

  const socket = await Bun.connect({ unix: ctx.path, socket: { data() {} } });

  registerTestCleanup(() => {
    socket.end();
  });

  const written = socket.write('x'.repeat(16 * 1024 * 1024));

  expect(written).toBeLessThan(16 * 1024 * 1024);
});

test('it stops listening once stopped', async () => {
  const ctx = setupTest();

  const listener = await startStubStalledListener(ctx.path);

  listener.stop();

  expect(Bun.connect({ unix: ctx.path, socket: { data() {} } })).rejects.toThrow();
});

test('it stops listening once the test finishes without a stop', async () => {
  // The socket sits outside any directory the test removes, so only the
  // listener's own stop takes it away.
  const path = join(tmpdir(), `atc-stub-stalled-${randomUUID()}.sock`);
  let left: boolean | null = null;

  // Runs after the helper's own release, which registers later; it
  // records whether that release left the socket, then removes it.
  registerTestCleanup(() => {
    left = existsSync(path);

    rmSync(path, { force: true });
  });

  await startStubStalledListener(path);

  onTestFinished(() => {
    expect(left).toBeFalse();
  });
});
