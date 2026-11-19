import { expect, onTestFinished, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTestCleanup } from '@atc/core/test-utils/register-test-cleanup';
import { setupTempDir } from '@atc/core/test-utils/setup-temp-dir';
import { waitFor } from '@atc/core/test-utils/wait-for';
import { startStubRecordingListener } from './start-stub-recording-listener';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-stub-recording-listener-');

  return { path: join(temporaryDirectory.path, 'recording.sock') };
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
  const path = join(tmpdir(), `atc-stub-recording-${randomUUID()}.sock`);
  let left: boolean | null = null;

  registerTestCleanup(() => {
    left = existsSync(path);

    rmSync(path, { force: true });
  });

  startStubRecordingListener(path);

  onTestFinished(() => {
    expect(left).toBeFalse();
  });
});
