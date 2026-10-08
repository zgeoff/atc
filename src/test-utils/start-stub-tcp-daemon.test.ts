import { expect, onTestFinished, test } from 'bun:test';
import { DaemonClient } from '../client/daemon-client';
import { startStubTCPDaemon } from './start-stub-tcp-daemon';
import { waitFor } from './wait-for';

test('it answers a request with an ok that holds its method', async () => {
  using daemon = startStubTCPDaemon();

  const client = await DaemonClient.open({ hostname: '127.0.0.1', port: daemon.port });

  onTestFinished(() => {
    client.stop();
  });

  const answer = await client.sendRequest('session.list');

  expect(answer).toStrictEqual({ m: 'session.list' });
});

test('it records the method of every request in arrival order', async () => {
  using daemon = startStubTCPDaemon();

  const client = await DaemonClient.open({ hostname: '127.0.0.1', port: daemon.port });

  onTestFinished(() => {
    client.stop();
  });

  await client.sendRequest('daemon.ping');
  await client.sendRequest('session.list');

  expect(daemon.seen).toStrictEqual(['daemon.ping', 'session.list']);
});

test('it answers a request split across two writes once its line ends', async () => {
  using daemon = startStubTCPDaemon();

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

  onTestFinished(() => {
    socket.end();
  });

  socket.write('{"v":4,"id":7,');

  await waitFor(() => {
    expect(daemon.reads).toBe(1);
  });

  socket.write('"m":"daemon.ping"}\n');

  await answered.promise;

  expect(answers).toStrictEqual(['{"v":4,"id":7,"ok":{"m":"daemon.ping"}}\n']);
});

test('it counts each read it takes from a connection', async () => {
  using daemon = startStubTCPDaemon();

  const socket = await Bun.connect({
    hostname: '127.0.0.1',
    port: daemon.port,
    socket: { data() {} },
  });

  onTestFinished(() => {
    socket.end();
  });

  socket.write('{"v":4,');

  await waitFor(() => {
    expect(daemon.reads).toBe(1);
  });
});

test('it stops listening once disposed', () => {
  const daemon = startStubTCPDaemon();

  daemon[Symbol.dispose]();

  const connecting = DaemonClient.open({ hostname: '127.0.0.1', port: daemon.port });

  expect(connecting).rejects.toMatchObject({ code: 'ECONNREFUSED' });
});

test('it stops listening once the test finishes without a dispose', () => {
  const daemon = startStubTCPDaemon();

  onTestFinished(() => {
    expect(
      Bun.connect({ hostname: '127.0.0.1', port: daemon.port, socket: { data() {} } }),
    ).rejects.toThrow();
  });
});

test('it stops once when disposed before the test finishes', () => {
  const daemon = startStubTCPDaemon();

  daemon[Symbol.dispose]();

  expect(
    Bun.connect({ hostname: '127.0.0.1', port: daemon.port, socket: { data() {} } }),
  ).rejects.toThrow();
});
