import { expect, onTestFinished, test } from 'bun:test';
import { startStubRefusingListener } from './start-stub-refusing-listener';

test('it records what a connection sends and ends that connection', async () => {
  using listener = startStubRefusingListener();

  const closed = Promise.withResolvers<void>();

  const socket = await Bun.connect({
    hostname: '127.0.0.1',
    port: listener.port,
    socket: {
      data() {},
      close() {
        closed.resolve();
      },
    },
  });

  onTestFinished(() => {
    socket.end();
  });

  socket.write('not a handshake\n');

  await closed.promise;

  expect(listener.received).toStrictEqual(['not a handshake\n']);
});

test('it stops listening once disposed', () => {
  const listener = startStubRefusingListener();

  listener[Symbol.dispose]();

  expect(
    Bun.connect({ hostname: '127.0.0.1', port: listener.port, socket: { data() {} } }),
  ).rejects.toThrow();
});

test('it stops listening once the test finishes without a dispose', () => {
  const listener = startStubRefusingListener();

  onTestFinished(() => {
    expect(
      Bun.connect({ hostname: '127.0.0.1', port: listener.port, socket: { data() {} } }),
    ).rejects.toThrow();
  });
});

test('it stops once when disposed before the test finishes', () => {
  const listener = startStubRefusingListener();

  listener[Symbol.dispose]();

  expect(
    Bun.connect({ hostname: '127.0.0.1', port: listener.port, socket: { data() {} } }),
  ).rejects.toThrow();
});
