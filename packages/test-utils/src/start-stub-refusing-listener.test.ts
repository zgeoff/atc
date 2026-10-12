import { expect, onTestFinished, test } from 'bun:test';
import { registerTestCleanup } from './register-test-cleanup';
import { startStubRefusingListener } from './start-stub-refusing-listener';

test('it records what a connection sends and ends that connection', async () => {
  const listener = startStubRefusingListener();
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

  registerTestCleanup(() => {
    socket.end();
  });

  socket.write('not a handshake\n');

  await closed.promise;

  expect(listener.received).toStrictEqual(['not a handshake\n']);
});

test('it stops listening once stopped', () => {
  const listener = startStubRefusingListener();

  listener.stop();

  expect(
    Bun.connect({ hostname: '127.0.0.1', port: listener.port, socket: { data() {} } }),
  ).rejects.toThrow();
});

test('it stops listening once the test finishes without a stop', () => {
  const listener = startStubRefusingListener();

  onTestFinished(() => {
    expect(
      Bun.connect({ hostname: '127.0.0.1', port: listener.port, socket: { data() {} } }),
    ).rejects.toThrow();
  });
});
