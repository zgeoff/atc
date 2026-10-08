import { expect, onTestFinished, test } from 'bun:test';
import { registerTestCleanup } from './register-test-cleanup';
import { startStubUnansweringListener } from './start-stub-unanswering-listener';
import { waitFor } from './wait-for';

test('it records what a connection sends, answers nothing, and keeps the connection open', async () => {
  const listener = startStubUnansweringListener();
  const events: string[] = [];

  const socket = await Bun.connect({
    hostname: '127.0.0.1',
    port: listener.port,
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

test('it stops listening once disposed', () => {
  const listener = startStubUnansweringListener();

  listener[Symbol.dispose]();

  expect(
    Bun.connect({ hostname: '127.0.0.1', port: listener.port, socket: { data() {} } }),
  ).rejects.toThrow();
});

test('it stops listening once the test finishes without a dispose', () => {
  const listener = startStubUnansweringListener();

  onTestFinished(() => {
    expect(
      Bun.connect({ hostname: '127.0.0.1', port: listener.port, socket: { data() {} } }),
    ).rejects.toThrow();
  });
});
