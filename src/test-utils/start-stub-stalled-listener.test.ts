import { expect, onTestFinished, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupTempDir } from './setup-temp-dir';
import { startStubStalledListener } from './start-stub-stalled-listener';

// A temp directory to hold the listener's socket. Disposal removes it.
function setupTest() {
  const tmp = setupTempDir('atc-stub-stalled-');

  return { path: join(tmp.dir, 'stalled.sock'), [Symbol.dispose]: tmp[Symbol.dispose] };
}

test('it accepts a connection and leaves a large write to it partly unsent', async () => {
  using ctx = setupTest();

  const listener = await startStubStalledListener(ctx.path);

  onTestFinished(() => {
    listener[Symbol.dispose]();
  });

  const socket = await Bun.connect({ unix: ctx.path, socket: { data() {} } });

  onTestFinished(() => {
    socket.end();
  });

  const written = socket.write('x'.repeat(16 * 1024 * 1024));

  expect(written).toBeLessThan(16 * 1024 * 1024);
});

test('it stops listening once disposed', async () => {
  using ctx = setupTest();

  const listener = await startStubStalledListener(ctx.path);

  listener[Symbol.dispose]();

  expect(Bun.connect({ unix: ctx.path, socket: { data() {} } })).rejects.toThrow();
});

test('it stops listening once the test finishes without a dispose', async () => {
  // The socket sits outside any directory the test removes, so only the
  // listener's own stop takes it away.
  const path = join(tmpdir(), `atc-stub-stalled-${randomUUID()}.sock`);

  await startStubStalledListener(path);

  onTestFinished(() => {
    expect(existsSync(path)).toBeFalse();
  });
});
