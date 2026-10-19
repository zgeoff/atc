import { expect, onTestFinished, test } from 'bun:test';
import { join } from 'node:path';
import { setupTempDir, waitFor } from '@atc/test-utils';
import { DaemonClient } from './daemon-client';

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

  const client = await DaemonClient.open(ctx.socketPath);

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

  const client = await DaemonClient.open(ctx.socketPath);

  const unanswered = client.sendRequest('session.list', {}, 'ci', 'Build bot');

  onTestFinished(async () => {
    client.stop();

    await expect(unanswered).toReject();
  });

  await waitFor(() => {
    expect(ctx.received.map((line): unknown => JSON.parse(line))).toStrictEqual([
      {
        i: expect.any(String),
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

  const client = await DaemonClient.open(ctx.socketPath);

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
