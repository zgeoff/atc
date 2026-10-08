import { expect, onTestFinished, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupTempDir } from './setup-temp-dir';
import { startStubUnansweringUnixListener } from './start-stub-unanswering-unix-listener';
import { waitFor } from './wait-for';

// A temp directory to hold the listener's socket. Disposal removes it.
function setupTest() {
  const tmp = setupTempDir('atc-stub-unanswering-');

  return { path: join(tmp.dir, 'unanswering.sock'), [Symbol.dispose]: tmp[Symbol.dispose] };
}

test('it records what a connection sends, answers nothing, and keeps the connection open', async () => {
  using ctx = setupTest();
  using listener = startStubUnansweringUnixListener(ctx.path);

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

  onTestFinished(() => {
    socket.end();
  });

  socket.write('{"hello":1}\n');

  await waitFor(() => {
    expect(listener.received).toStrictEqual(['{"hello":1}\n']);
  });

  expect(events).toStrictEqual([]);
});

test('it stops listening once disposed', () => {
  using ctx = setupTest();

  const listener = startStubUnansweringUnixListener(ctx.path);

  listener[Symbol.dispose]();

  expect(Bun.connect({ unix: ctx.path, socket: { data() {} } })).rejects.toThrow();
});

test('it stops listening once the test finishes without a dispose', () => {
  // The socket sits outside any directory the test removes, so only the
  // listener's own stop takes it away.
  const path = join(tmpdir(), `atc-stub-unanswering-${randomUUID()}.sock`);

  startStubUnansweringUnixListener(path);

  onTestFinished(() => {
    expect(existsSync(path)).toBeFalse();
  });
});

test('it stops once when disposed before the test finishes', () => {
  const path = join(tmpdir(), `atc-stub-unanswering-${randomUUID()}.sock`);
  const listener = startStubUnansweringUnixListener(path);

  listener[Symbol.dispose]();

  expect(existsSync(path)).toBeFalse();
});
