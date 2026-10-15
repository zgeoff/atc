import { expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  registerTestCleanup,
  setupTempDir,
  startStubClosingListener,
  startStubStalledListener,
  startStubTCPDaemon,
  startStubUnansweringListener,
  waitFor,
} from '@atc/test-utils';
import { DaemonClient } from './daemon-client';
import { PROTOCOL_V } from './protocol';

/**
 * A daemon socket in a fresh temp directory whose listener closes every
 * connection as soon as it opens.
 */
function setupTest() {
  const tmp = setupTempDir('atc-daemon-client-');
  const socketPath = join(tmp.dir, 'daemon.sock');

  startStubClosingListener(socketPath);

  return { socketPath };
}

test('it rejects a request sent after the daemon closed the connection', async () => {
  const ctx = setupTest();

  const client = await DaemonClient.open(ctx.socketPath);

  registerTestCleanup(() => {
    client.stop();
  });

  const closed = Promise.withResolvers<void>();

  client.onClose = () => {
    closed.resolve();
  };

  await closed.promise;

  expect(client.sendRequest('daemon.ping')).rejects.toMatchObject({
    code: 'internal',
    message: 'connection closed',
  });
});

test('it sends a request that gives no principal as the client principal', async () => {
  const listener = startStubUnansweringListener();

  const client = await DaemonClient.open({ hostname: '127.0.0.1', port: listener.port });

  registerTestCleanup(() => {
    client.stop();
  });

  client.principal = 'remote-tui';

  // The listener never answers, so the request settles only when the
  // client stops; settling it as a list keeps that rejection handled.
  void Promise.allSettled([client.sendRequest('session.list')]);

  const sent = await waitFor(() => {
    const [line] = listener.received.join('').split('\n');

    if (line === undefined || line === '') {
      throw new Error('the listener has received no line yet');
    }

    return JSON.parse(line) as unknown;
  });

  expect(sent).toStrictEqual({ v: PROTOCOL_V, id: 1, m: 'session.list', as: 'remote-tui' });
});

test('it sends a request that gives its own principal as that principal', async () => {
  const listener = startStubUnansweringListener();

  const client = await DaemonClient.open({ hostname: '127.0.0.1', port: listener.port });

  registerTestCleanup(() => {
    client.stop();
  });

  client.principal = 'remote-tui';

  // The listener never answers, so the request settles only when the
  // client stops; settling it as a list keeps that rejection handled.
  void Promise.allSettled([client.sendRequest('session.list', undefined, 'gateway')]);

  const sent = await waitFor(() => {
    const [line] = listener.received.join('').split('\n');

    if (line === undefined || line === '') {
      throw new Error('the listener has received no line yet');
    }

    return JSON.parse(line) as unknown;
  });

  expect(sent).toStrictEqual({ v: PROTOCOL_V, id: 1, m: 'session.list', as: 'gateway' });
});

test('it sends the principal a handshake gives among its params', async () => {
  const listener = startStubUnansweringListener();

  const client = await DaemonClient.open({ hostname: '127.0.0.1', port: listener.port });

  registerTestCleanup(() => {
    client.stop();
  });

  // The listener never answers, so the handshake settles only when the
  // client stops; settling it as a list keeps that rejection handled.
  void Promise.allSettled([
    client.sendHello('atc/test-client', { token: 'a'.repeat(32), principal: 'remote-tui' }),
  ]);

  const sent = await waitFor(() => {
    const [line] = listener.received.join('').split('\n');

    if (line === undefined || line === '') {
      throw new Error('the listener has received no line yet');
    }

    return JSON.parse(line) as unknown;
  });

  expect(sent).toStrictEqual({
    v: PROTOCOL_V,
    id: 1,
    m: 'daemon.hello',
    p: {
      client: 'atc/test-client',
      auth: { scheme: 'bearer', token: 'a'.repeat(32) },
      principal: 'remote-tui',
    },
  });
});

test('it shows each answer and its method to the answer hook before the request resolves', async () => {
  const daemon = startStubTCPDaemon();

  const client = await DaemonClient.open({ hostname: '127.0.0.1', port: daemon.port });

  registerTestCleanup(() => {
    client.stop();
  });

  const seen: (readonly [string, Readonly<Record<string, unknown>>])[] = [];

  client.onAnswer = (method, ok) => {
    seen.push([method, ok]);
  };

  const answer = await client.sendRequest('session.list');

  expect(seen).toStrictEqual([['session.list', { m: 'session.list' }]]);
  expect(answer).toStrictEqual({ m: 'session.list' });
});

test('it rejects a request whose answer the answer hook throws for', async () => {
  const daemon = startStubTCPDaemon();

  const client = await DaemonClient.open({ hostname: '127.0.0.1', port: daemon.port });

  registerTestCleanup(() => {
    client.stop();
  });

  client.onAnswer = () => {
    throw new Error('outside the contract');
  };

  expect(client.sendRequest('session.list')).rejects.toMatchObject({
    code: 'internal',
    message: 'Error: outside the contract',
  });
});

test('it rejects a request at once when the full outbound queue refuses it', async () => {
  const tmp = setupTempDir('atc-daemon-client-');
  const socketPath = join(tmp.dir, 'stalled.sock');

  await startStubStalledListener(socketPath);

  const client = await DaemonClient.open(socketPath);

  registerTestCleanup(() => {
    client.stop();
  });

  // Larger than the queue holds, so most of it stays queued behind a peer
  // that never reads, and the queue refuses whatever comes next. It
  // rejects once the cleanup stops the client.
  const filler = client.sendRequest('session.create', { prompt: 'z'.repeat(10 * 1024 * 1024) });

  void Promise.allSettled([filler]);

  expect(client.sendRequest('daemon.ping')).rejects.toMatchObject({
    code: 'internal',
    message: 'outbound queue full',
  });
});
