import { expect, onTestFinished, test } from 'bun:test';
import { join } from 'node:path';
import { setupTempDir } from './setup-temp-dir';
import { startStubRecordingListener } from './start-stub-recording-listener';
import { waitFor } from './wait-for';

// A temp directory to hold the listener's socket. Disposal removes it.
function setupTest() {
  const tmp = setupTempDir('atc-stub-recording-listener-');

  return { path: join(tmp.dir, 'recording.sock'), [Symbol.dispose]: tmp[Symbol.dispose] };
}

test('it records what a connection sends and sends nothing back', async () => {
  using ctx = setupTest();
  using listener = startStubRecordingListener(ctx.path);

  let replies = '';

  const socket = await Bun.connect({
    unix: ctx.path,
    socket: {
      data(_socket, data) {
        replies += data.toString();
      },
    },
  });

  onTestFinished(() => socket.end());

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
  using ctx = setupTest();
  using listener = startStubRecordingListener(ctx.path);

  const received: string[] = [];

  const socket = await Bun.connect({
    unix: ctx.path,
    socket: {
      data(_socket, data) {
        received.push(data.toString());
      },
    },
  });

  onTestFinished(() => socket.end());

  const peer = await listener.accepted;

  peer.write('hello');

  await waitFor(() => {
    expect(received.join('')).toBe('hello');
  });
});

test('it stops listening once disposed', () => {
  using ctx = setupTest();

  const listener = startStubRecordingListener(ctx.path);

  onTestFinished(() => {
    listener[Symbol.dispose]();
  });

  listener[Symbol.dispose]();

  expect(Bun.connect({ unix: ctx.path, socket: { data() {} } })).rejects.toThrow();
});
