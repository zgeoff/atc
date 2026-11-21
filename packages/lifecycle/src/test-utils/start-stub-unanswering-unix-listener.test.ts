import { expect, onTestFinished, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTestCleanup, waitFor } from '@zgeoff/testing';
import { createTempDir } from '@zgeoff/testing/fs';
import { startStubUnansweringUnixListener } from './start-stub-unanswering-unix-listener';

function setupTest() {
  const temporaryDirectory = createTempDir('atc-stub-unanswering-');

  return { path: join(temporaryDirectory.path, 'unanswering.sock') };
}

test('it records what a connection sends, answers nothing, and keeps the connection open', async () => {
  const ctx = setupTest();
  const listener = startStubUnansweringUnixListener(ctx.path);
  const events: string[] = [];

  const socket = await Bun.connect({
    unix: ctx.path,
    socket: {
      data(_socket, data) {
        events.push(`data ${data.toString()}`);
      },
      close() {
        events.push('close');
      },
    },
  });

  registerTestCleanup(() => {
    socket.end();
  });

  socket.write('{"hello":1}\n');

  await waitFor(() => {
    expect(listener.received).toStrictEqual(['{"hello":1}\n']);
  });

  expect(events).toStrictEqual([]);
});

test('it stops listening once stopped', () => {
  const ctx = setupTest();
  const listener = startStubUnansweringUnixListener(ctx.path);

  listener.stop();

  expect(Bun.connect({ unix: ctx.path, socket: { data() {} } })).rejects.toThrow();
});

test('it stops listening once the test finishes without a stop', () => {
  const path = join(tmpdir(), `atc-stub-unanswering-${randomUUID()}.sock`);
  let left: boolean | null = null;

  registerTestCleanup(() => {
    left = existsSync(path);

    rmSync(path, { force: true });
  });

  startStubUnansweringUnixListener(path);

  onTestFinished(() => {
    expect(left).toBeFalse();
  });
});
