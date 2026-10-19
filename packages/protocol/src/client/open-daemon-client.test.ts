import { expect, mock, onTestFinished, test } from 'bun:test';
import { join } from 'node:path';
import { setupTempDir, startStubPeerDaemon, waitFor } from '@atc/test-utils';
import type { StubPeerAnswer, StubPeerRequest } from '@atc/test-utils';
import { PROTOCOL_V } from '../wire/protocol';
import { openDaemonClient } from './open-daemon-client';

function setupTest() {
  const tmp = setupTempDir('atc-daemon-client-');
  const socketPath = join(tmp.dir, 'daemon.sock');
  const received: string[] = [];

  return { socketPath, received };
}

test('it refuses every waiting request with a protocol mismatch when the daemon answers in the line protocol', async () => {
  const ctx = setupTest();

  const server = Bun.listen({
    unix: ctx.socketPath,
    socket: {
      data(socket) {
        socket.write(
          `${JSON.stringify({ v: 4, id: 0, err: { code: 'bad_args', msg: 'malformed line: missing v' } })}\n`,
        );

        socket.end();
      },
    },
  });

  onTestFinished(() => {
    server.stop(true);
  });

  const client = await openDaemonClient(ctx.socketPath);

  onTestFinished(() => {
    client.stop();
  });

  expect(client.sendHello('atc/test')).rejects.toMatchObject({
    code: 'protocol_mismatch',
    message: 'the daemon speaks an older protocol; restart the daemon so both run the same build',
  });
});

test('it sends the principal a request acts as, and its name, as headers', async () => {
  const ctx = setupTest();

  const server = Bun.listen({
    unix: ctx.socketPath,
    socket: {
      data(_socket, buf) {
        ctx.received.push(...new TextDecoder().decode(buf).split('\n').filter(Boolean));
      },
    },
  });

  onTestFinished(() => {
    server.stop(true);
  });

  const client = await openDaemonClient(ctx.socketPath);

  const unanswered = client.sendRequest('session.list', {}, 'ci', 'Build bot');

  onTestFinished(async () => {
    client.stop();

    await expect(unanswered).toReject();
  });

  await waitFor(() => {
    expect(ctx.received.map((line): unknown => JSON.parse(line))).toStrictEqual([
      {
        i: expect.any(String) as unknown,
        p: {
          u: '/session/list',
          b: { json: {} },
          h: { 'x-atc-as': 'ci', 'x-atc-as-name': 'Build bot' },
        },
      },
    ]);
  });
});

test('it rejects a request sent after the connection ended', async () => {
  const ctx = setupTest();

  const server = Bun.listen({
    unix: ctx.socketPath,
    socket: {
      open(socket) {
        socket.end();
      },
      data() {},
    },
  });

  onTestFinished(() => {
    server.stop(true);
  });

  const client = await openDaemonClient(ctx.socketPath);

  onTestFinished(() => {
    client.stop();
  });

  await waitFor(() => {
    expect(client.isClosed()).toBeTrue();
  });

  expect(client.sendRequest('daemon.ping')).rejects.toMatchObject({
    code: 'internal',
    message: 'connection closed',
  });
});

test('it rejects a typed procedure call after the client stops, with the reason it closed', async () => {
  const ctx = setupTest();

  startStubPeerDaemon(ctx.socketPath, { answer: () => ({ ok: {} }) });

  const client = await openDaemonClient(ctx.socketPath);

  client.stop();

  expect(client.procedures.daemon.ping({})).rejects.toMatchObject({
    code: 'internal',
    message: 'connection closed',
  });
});

test('it sends its handshake with its protocol version and subscribes as the principal it gave', async () => {
  const ctx = setupTest();
  const answers: Readonly<Record<string, StubPeerAnswer>> = { 'daemon.hello': { ok: {} } };

  const answer = mock<(request: StubPeerRequest) => StubPeerAnswer>(
    (request) => answers[request.method] ?? 'silent',
  );

  startStubPeerDaemon(ctx.socketPath, { answer });

  const client = await openDaemonClient(ctx.socketPath);

  onTestFinished(() => {
    client.stop();
  });

  await client.sendHello('atc/test', { principal: 'ci' });

  await waitFor(() => {
    expect(answer.mock.calls.map((call) => call[0])).toStrictEqual([
      {
        method: 'daemon.hello',
        params: {
          protocol: PROTOCOL_V,
          client: 'atc/test',
          auth: { scheme: 'none' },
          principal: 'ci',
        },
        as: undefined,
        asName: undefined,
      },
      { method: 'events.subscribe', params: {}, as: 'ci', asName: undefined },
    ]);
  });
});

test('it closes the connection with the reason when the daemon refuses its event subscription', async () => {
  const ctx = setupTest();

  const answers: Readonly<Record<string, StubPeerAnswer>> = {
    'daemon.hello': { ok: {} },
    'events.subscribe': {
      err: { code: 'unauthorized', msg: 'a request over TCP must act as a principal' },
    },
  };

  startStubPeerDaemon(ctx.socketPath, { answer: (request) => answers[request.method] ?? 'silent' });

  const client = await openDaemonClient(ctx.socketPath);

  onTestFinished(() => {
    client.stop();
  });

  await client.sendHello('atc/test');

  await waitFor(() => {
    expect(client.isClosed()).toBeTrue();
  });

  expect(client.sendRequest('daemon.ping')).rejects.toMatchObject({
    code: 'internal',
    message: 'the event subscription failed: a request over TCP must act as a principal',
  });
});
