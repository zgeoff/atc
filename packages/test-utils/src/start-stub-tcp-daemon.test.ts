import { expect, onTestFinished, test } from 'bun:test';
import { openDaemonClient } from '@atc/protocol/client';
import { registerTestCleanup } from './register-test-cleanup';
import { startStubTCPDaemon } from './start-stub-tcp-daemon';
import { waitFor } from './wait-for';

test('it answers a request with an ok that holds its method', async () => {
  const daemon = startStubTCPDaemon();

  const client = await openDaemonClient({ hostname: '127.0.0.1', port: daemon.port });

  registerTestCleanup(() => {
    client.stop();
  });

  const answer = await client.sendRequest('session.list');

  expect(answer).toStrictEqual({ method: 'session.list' });
});

test('it records the method of every request in arrival order', async () => {
  const daemon = startStubTCPDaemon();

  const client = await openDaemonClient({ hostname: '127.0.0.1', port: daemon.port });

  registerTestCleanup(() => {
    client.stop();
  });

  await client.sendRequest('daemon.ping');
  await client.sendRequest('session.list');

  expect(daemon.seen).toStrictEqual(['daemon.ping', 'session.list']);
});

test('it answers a request split across two writes once its line ends', async () => {
  const daemon = startStubTCPDaemon();
  const answers: string[] = [];
  const answered = Promise.withResolvers<void>();

  const socket = await Bun.connect({
    hostname: '127.0.0.1',
    port: daemon.port,
    socket: {
      data(_socket, buf) {
        answers.push(buf.toString());
        answered.resolve();
      },
    },
  });

  registerTestCleanup(() => {
    socket.end();
  });

  socket.write('{"i":"7","p":{"u":"/daemon/ping",');

  await waitFor(() => {
    expect(daemon.reads).toBe(1);
  });

  socket.write('"b":{"json":{}}}}\n');

  await answered.promise;

  expect(answers).toStrictEqual(['{"i":"7","p":{"b":{"json":{"method":"daemon.ping"}}}}\n']);
});

test('it counts each read it takes from a connection', async () => {
  const daemon = startStubTCPDaemon();

  const socket = await Bun.connect({
    hostname: '127.0.0.1',
    port: daemon.port,
    socket: { data() {} },
  });

  registerTestCleanup(() => {
    socket.end();
  });

  socket.write('{"i":"1",');

  await waitFor(() => {
    expect(daemon.reads).toBe(1);
  });
});

test('it stops listening once stopped', () => {
  const daemon = startStubTCPDaemon();

  daemon.stop();

  const connecting = openDaemonClient({ hostname: '127.0.0.1', port: daemon.port });

  expect(connecting).rejects.toMatchObject({ code: 'ECONNREFUSED' });
});

test('it stops listening once the test finishes without a stop', () => {
  const daemon = startStubTCPDaemon();

  onTestFinished(() => {
    expect(
      Bun.connect({ hostname: '127.0.0.1', port: daemon.port, socket: { data() {} } }),
    ).rejects.toThrow();
  });
});
