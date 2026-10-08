import { expect, onTestFinished, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTestCleanup } from './register-test-cleanup';
import { setupTempDir } from './setup-temp-dir';
import { startStubRecordingListener } from './start-stub-recording-listener';
import { waitFor } from './wait-for';

// A temp directory to hold the listener's socket.
function setupTest() {
  const tmp = setupTempDir('atc-stub-recording-listener-');

  return { path: join(tmp.dir, 'recording.sock') };
}

test('it records what a connection sends and sends nothing back', async () => {
  const ctx = setupTest();
  const listener = startStubRecordingListener(ctx.path);
  let replies = '';

  const socket = await Bun.connect({
    unix: ctx.path,
    socket: {
      data(_socket, data) {
        replies += data.toString();
      },
    },
  });

  registerTestCleanup(() => socket.end());

  const peer = await listener.accepted;

  socket.write('go');

  await waitFor(() => {
    expect(listener.received).toStrictEqual(['go']);
  });

  // The test's own marker follows anything the listener sent on the same
  // connection, so its arrival shows every reply has arrived.
  peer.write('end');

  await waitFor(() => {
    expect(replies).toEndWith('end');
  });

  expect(replies).toBe('end');
});

test('it hands the test the server side of the first connection', async () => {
  const ctx = setupTest();
  const listener = startStubRecordingListener(ctx.path);
  const received: string[] = [];

  const socket = await Bun.connect({
    unix: ctx.path,
    socket: {
      data(_socket, data) {
        received.push(data.toString());
      },
    },
  });

  registerTestCleanup(() => socket.end());

  const peer = await listener.accepted;

  peer.write('hello');

  await waitFor(() => {
    expect(received.join('')).toBe('hello');
  });
});

test('it stops listening once stopped', () => {
  const ctx = setupTest();
  const listener = startStubRecordingListener(ctx.path);

  listener.stop();

  expect(Bun.connect({ unix: ctx.path, socket: { data() {} } })).rejects.toThrow();
});

test('it stops listening once the test finishes without a stop', () => {
  // The socket sits outside any directory the test removes, so only the
  // listener's own stop takes it away.
  const path = join(tmpdir(), `atc-stub-recording-${randomUUID()}.sock`);

  startStubRecordingListener(path);

  onTestFinished(() => {
    expect(existsSync(path)).toBeFalse();
  });
});
