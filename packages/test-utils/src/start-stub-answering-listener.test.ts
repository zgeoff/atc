import { expect, onTestFinished, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTestCleanup } from './register-test-cleanup';
import { setupTempDir } from './setup-temp-dir';
import { startStubAnsweringListener } from './start-stub-answering-listener';
import { waitFor } from './wait-for';

// A temp directory to hold the listener's socket, removed once the test
// finishes.
function setupTest() {
  const tmp = setupTempDir('atc-stub-answering-');

  return { path: join(tmp.dir, 'answering.sock') };
}

test('it records the first read and answers it with one line', async () => {
  const ctx = setupTest();

  const listener = await startStubAnsweringListener(ctx.path);

  const socket = createConnection(ctx.path);

  registerTestCleanup(() => socket.destroy());

  const answered = Promise.withResolvers<string>();

  socket.once('data', (data) => {
    answered.resolve(data.toString());
  });

  socket.write('hello\n');

  const answer = await answered.promise;

  expect(answer).toBe('answer\n');
  expect(listener.lines).toStrictEqual(['hello\n']);
  expect(listener.peers).toHaveLength(1);
});

test('it leaves every byte after the first read unread', async () => {
  const ctx = setupTest();

  const listener = await startStubAnsweringListener(ctx.path);

  const socket = createConnection(ctx.path);

  registerTestCleanup(() => socket.destroy());

  const answered = Promise.withResolvers<void>();

  socket.once('data', () => {
    answered.resolve();
  });

  socket.write('hello\n');

  await answered.promise;

  socket.write('more\n');

  await waitFor(() => {
    expect(listener.peers[0]?.readableLength).toBe(5);
  });

  expect(listener.lines).toStrictEqual(['hello\n']);
});

test('it closes every connection it accepted once stopped', async () => {
  const ctx = setupTest();

  const listener = await startStubAnsweringListener(ctx.path);

  const socket = createConnection(ctx.path);

  registerTestCleanup(() => socket.destroy());

  const closed = Promise.withResolvers<void>();

  socket.once('close', () => {
    closed.resolve();
  });

  await waitFor(() => {
    expect(listener.peers).toBeArrayOfSize(1);
  });

  await listener.stop();

  expect(closed.promise).resolves.toBeUndefined();
});

test('it stops listening once stopped', async () => {
  const ctx = setupTest();

  const listener = await startStubAnsweringListener(ctx.path);

  await listener.stop();

  expect(Bun.connect({ unix: ctx.path, socket: { data() {} } })).rejects.toThrow();
});

test('it stops listening once the test finishes without a stop', async () => {
  // The socket sits outside any directory the test removes, so only the
  // listener's own stop takes it away.
  const path = join(tmpdir(), `atc-stub-answering-${randomUUID()}.sock`);
  let left: boolean | null = null;

  // Runs after the helper's own release, which registers later; it
  // records whether that release left the socket, then removes it.
  registerTestCleanup(() => {
    left = existsSync(path);

    rmSync(path, { force: true });
  });

  await startStubAnsweringListener(path);

  onTestFinished(() => {
    expect(left).toBeFalse();
  });
});
