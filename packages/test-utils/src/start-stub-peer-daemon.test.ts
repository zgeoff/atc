import { expect, mock, test } from 'bun:test';
import { join } from 'node:path';
import { openDaemonClient } from '@atc/protocol/client';
import invariant from 'tiny-invariant';
import { registerTestCleanup } from './register-test-cleanup';
import { setupTempDir } from './setup-temp-dir';
import { startStubPeerDaemon } from './start-stub-peer-daemon';
import type { StubPeerAnswer, StubPeerRequest } from './start-stub-peer-daemon';
import { waitFor } from './wait-for';

function setupTest() {
  const tmp = setupTempDir('atc-stub-peer-');

  return { socketPath: join(tmp.dir, 'daemon.sock') };
}

test('it answers a request with the answer the caller gives', async () => {
  const ctx = setupTest();

  startStubPeerDaemon(ctx.socketPath, { answer: () => ({ ok: { sessions: [] } }) });

  const client = await openDaemonClient(ctx.socketPath);

  registerTestCleanup(() => {
    client.stop();
  });

  const listed = await client.sendRequest('session.list');

  expect(listed).toStrictEqual({ sessions: [] });
});

test('it passes the caller each request with its method, params and principal', async () => {
  const ctx = setupTest();
  const answer = mock<(request: StubPeerRequest) => StubPeerAnswer>(() => ({ ok: {} }));

  startStubPeerDaemon(ctx.socketPath, { answer });

  const client = await openDaemonClient(ctx.socketPath);

  registerTestCleanup(() => {
    client.stop();
  });

  await client.sendRequest('session.ack', { session: 's-4' }, 'ci', 'Build bot');

  expect(answer).toHaveBeenCalledExactlyOnceWith({
    method: 'session.ack',
    params: { session: 's-4' },
    as: 'ci',
    asName: 'Build bot',
  });
});

test('it refuses a request with the code, message and data the caller gives', async () => {
  const ctx = setupTest();

  startStubPeerDaemon(ctx.socketPath, {
    answer: () => ({
      err: { code: 'scope_invalid', msg: 'the scope does not read', data: { entry: 2 } },
    }),
  });

  const client = await openDaemonClient(ctx.socketPath);

  registerTestCleanup(() => {
    client.stop();
  });

  expect(client.sendRequest('session.scope.add', { session: 's-5' })).rejects.toMatchObject({
    code: 'scope_invalid',
    message: 'the scope does not read',
    data: { entry: 2 },
  });
});

test('it ends the connection in place of an answer when the caller says close', async () => {
  const ctx = setupTest();

  startStubPeerDaemon(ctx.socketPath, { answer: () => 'close' });

  const client = await openDaemonClient(ctx.socketPath);

  registerTestCleanup(() => {
    client.stop();
  });

  expect(client.sendRequest('daemon.ping')).rejects.toMatchObject({
    code: 'internal',
    message: 'connection closed',
  });
});

test('it leaves a request unanswered when the caller says silent', async () => {
  const ctx = setupTest();

  startStubPeerDaemon(ctx.socketPath, {
    answer: (request) => (request.method === 'daemon.ping' ? { ok: {} } : 'silent'),
  });

  const client = await openDaemonClient(ctx.socketPath);

  registerTestCleanup(() => {
    client.stop();
  });

  const listed = client.sendRequest('session.list');

  // Closing the client rejects the withheld list; nothing awaits it.
  void Promise.allSettled([listed]);

  await client.sendRequest('daemon.ping');

  expect(Bun.peek.status(listed)).toBe('pending');
});

test('it counts each read and each connection', async () => {
  const ctx = setupTest();
  const daemon = startStubPeerDaemon(ctx.socketPath, { answer: () => 'silent' });

  const raw = await Bun.connect({ unix: ctx.socketPath, socket: { data() {} } });

  registerTestCleanup(() => {
    raw.end();
  });

  raw.write('{"i":"1",');

  await waitFor(() => {
    expect(daemon.reads).toBe(1);
  });

  expect(daemon.connections).toStrictEqual({ accepted: 1, open: 1 });
});

test('it answers on the TCP port it bound when given a TCP address', async () => {
  const daemon = startStubPeerDaemon(
    { hostname: '127.0.0.1', port: 0 },
    { answer: () => ({ ok: {} }) },
  );

  invariant(daemon.port !== null);

  const client = await openDaemonClient({ hostname: '127.0.0.1', port: daemon.port });

  registerTestCleanup(() => {
    client.stop();
  });

  const pong = await client.sendRequest('daemon.ping');

  expect(pong).toStrictEqual({});
});

test('it stops listening when stopped', () => {
  const ctx = setupTest();
  const daemon = startStubPeerDaemon(ctx.socketPath, { answer: () => ({ ok: {} }) });

  daemon.stop();

  expect(openDaemonClient(ctx.socketPath)).rejects.toThrow();
});
