import { expect, mock, onTestFinished, spyOn, test } from 'bun:test';
import { createServer } from 'node:net';
import type { Socket } from 'node:net';
import { join } from 'node:path';
import {
  buildPeerRequestLine,
  getString,
  setupTempDir,
  startStubPeerDaemon,
  waitFor,
} from '@atc/test-utils';
import type { StubPeerAnswer, StubPeerRequest } from '@atc/test-utils';
import { z } from 'zod';
import { PROTOCOL_V } from '../wire/protocol';
import { openDaemonClient } from './open-daemon-client';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-daemon-client-');
  const socketPath = join(temporaryDirectory.path, 'daemon.sock');
  const received: string[] = [];

  return { socketPath, received };
}

test('it refuses every waiting request as a closed connection when the daemon answers with a line that is no peer message', async () => {
  const ctx = setupTest();

  const server = Bun.listen({
    unix: ctx.socketPath,
    socket: {
      data(socket) {
        socket.write(
          '{"v":4,"id":0,"err":{"code":"bad_args","msg":"malformed line: missing v"}}\n',
        );
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
    code: 'internal',
    message: 'connection closed',
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
    expect(ctx.received).toHaveLength(1);
  });

  // The request id is the client's own choice, so the expected line takes it.
  const expected = ctx.received.map((line) => {
    const parsed: unknown = JSON.parse(line);
    const request = z.record(z.string(), z.unknown()).parse(parsed);
    const headers = { 'x-atc-as': 'ci', 'x-atc-as-name': 'Build bot' };

    return buildPeerRequestLine(getString(request, 'i'), '/session/list', {}, headers).trimEnd();
  });

  expect(ctx.received).toStrictEqual(expected);
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
      err: { code: 'unauthorized', message: 'a request over TCP must act as a principal' },
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

test("it sends a typed procedure call as the client's principal when the call gives none", async () => {
  const ctx = setupTest();
  const requests: StubPeerRequest[] = [];

  startStubPeerDaemon(ctx.socketPath, {
    answer: (request) => {
      requests.push(request);

      return { ok: { sessions: [] } };
    },
  });

  const client = await openDaemonClient(ctx.socketPath);

  onTestFinished(() => {
    client.stop();
  });

  client.principal = 'ci';

  await client.procedures.session.list({});

  expect(requests).toStrictEqual([
    { method: 'session.list', params: {}, as: 'ci', asName: undefined },
  ]);
});

test('it delivers every request whole once a reader that took nothing reads again', async () => {
  const ctx = setupTest();
  const lines: string[] = [];
  const reading = Promise.withResolvers<Socket>();
  let buffered = '';

  const server = createServer((socket) => {
    socket.pause();
    socket.setEncoding('utf8');

    socket.on('data', (chunk: string) => {
      buffered += chunk;

      const split = buffered.split('\n');

      buffered = split.pop() ?? '';

      lines.push(...split);
    });

    reading.resolve(socket);
  });

  server.listen(ctx.socketPath);

  onTestFinished(() => {
    server.close();
  });

  const client = await openDaemonClient(ctx.socketPath);

  // The requests stay unanswered, and the stop rejects them.
  const sent = Array.from({ length: 10 }, (_, index) =>
    client.sendRequest('session.message', { session: 's-1', text: `${index}`.repeat(200_000) }),
  );

  onTestFinished(async () => {
    client.stop();

    await Promise.allSettled(sent);
  });

  const socket = await reading.promise;

  socket.resume();

  await waitFor(() => {
    expect(lines).toHaveLength(10);
  });

  const texts = lines.map((line) => {
    const parsed: unknown = JSON.parse(line);

    return JSON.stringify(parsed).length;
  });

  expect(texts).toSatisfyAll((length: number) => length > 200_000);
});

test('it hands the answer handler each method and answer before the request resolves', async () => {
  const ctx = setupTest();

  startStubPeerDaemon(ctx.socketPath, { answer: () => ({ ok: { sessions: [] } }) });

  const client = await openDaemonClient(ctx.socketPath);

  onTestFinished(() => {
    client.stop();
  });

  const seen: unknown[] = [];
  let isResolved = false;

  client.onAnswer = (method, ok) => {
    seen.push({ method, ok, isResolved });
  };

  await client.sendRequest('session.list');

  isResolved = true;

  expect(seen).toStrictEqual([{ method: 'session.list', ok: { sessions: [] }, isResolved: false }]);
});

test('it rejects a request as internal when the answer handler throws', async () => {
  const ctx = setupTest();

  startStubPeerDaemon(ctx.socketPath, { answer: () => ({ ok: { sessions: [] } }) });

  const client = await openDaemonClient(ctx.socketPath);

  onTestFinished(() => {
    client.stop();
  });

  client.onAnswer = () => {
    throw new Error('the handler broke');
  };

  expect(client.sendRequest('session.list')).rejects.toMatchObject({
    code: 'internal',
    message: 'Error: the handler broke',
  });
});

test('it reports a close handler that throws instead of leaving it unhandled', async () => {
  const ctx = setupTest();
  const daemon = startStubPeerDaemon(ctx.socketPath, { answer: () => 'silent' });
  const reported = spyOn(console, 'error').mockImplementation(() => {});

  onTestFinished(() => {
    reported.mockRestore();
  });

  const client = await openDaemonClient(ctx.socketPath);

  client.onClose = () => {
    throw new Error('the close handler broke');
  };

  daemon.stop();

  await waitFor(() => {
    expect(reported).toHaveBeenCalledWith(
      "atc: the daemon client's close handler failed: Error: the close handler broke",
    );
  });
});
