import { expect, onTestFinished, test } from 'bun:test';
import { z } from 'zod';
import { DaemonClient } from '../client/daemon-client';
import { startCutProxy } from './start-cut-proxy';
import { waitFor } from './wait-for';

/**
 * A line server on a loopback port standing in for the proxy's target: it
 * answers every request line with an ok holding the request's method, and
 * records each method it got in `seen`.
 */
function setupTest() {
  const seen: string[] = [];

  const server = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      data(socket, buf) {
        for (const line of buf
          .toString()
          .split('\n')
          .filter((part) => part !== '')) {
          const request = z.object({ id: z.number(), m: z.string() }).parse(JSON.parse(line));

          seen.push(request.m);
          socket.write(`${JSON.stringify({ v: 4, id: request.id, ok: { m: request.m } })}\n`);
        }
      },
      error() {},
    },
  });

  return {
    port: server.port,
    seen,
    [Symbol.asyncDispose]: () => {
      server.stop(true);

      return Promise.resolve();
    },
  };
}

test('it forwards requests and answers of other methods unchanged', async () => {
  await using ctx = setupTest();

  const proxy = startCutProxy({
    target: { hostname: '127.0.0.1', port: ctx.port },
    method: 'session.spawn',
    cuts: 1,
    mode: 'close',
  });

  onTestFinished(() => {
    proxy.stop();
  });

  const client = await DaemonClient.open({ hostname: '127.0.0.1', port: proxy.port });

  onTestFinished(() => {
    client.stop();
  });

  const answer = await client.sendRequest('session.list');

  expect(answer).toStrictEqual({ m: 'session.list' });
});

test('it closes the connection in place of the answer to a cut request that reached the target', async () => {
  await using ctx = setupTest();

  const proxy = startCutProxy({
    target: { hostname: '127.0.0.1', port: ctx.port },
    method: 'session.spawn',
    cuts: 1,
    mode: 'close',
  });

  onTestFinished(() => {
    proxy.stop();
  });

  const client = await DaemonClient.open({ hostname: '127.0.0.1', port: proxy.port });

  onTestFinished(() => {
    client.stop();
  });

  const closed = Promise.withResolvers<void>();

  client.onClose = () => {
    closed.resolve();
  };

  const reply = client.sendRequest('session.spawn');

  await closed.promise;

  expect(reply).rejects.toMatchObject({ code: 'internal' });
  expect(ctx.seen).toStrictEqual(['session.spawn']);
  expect(proxy.countRequests()).toBe(1);
});

test('it forwards the answer once its cuts are spent', async () => {
  await using ctx = setupTest();

  const proxy = startCutProxy({
    target: { hostname: '127.0.0.1', port: ctx.port },
    method: 'session.spawn',
    cuts: 1,
    mode: 'close',
  });

  onTestFinished(() => {
    proxy.stop();
  });

  const cut = await DaemonClient.open({ hostname: '127.0.0.1', port: proxy.port });

  onTestFinished(() => {
    cut.stop();
  });

  await Promise.allSettled([cut.sendRequest('session.spawn')]);

  const fresh = await DaemonClient.open({ hostname: '127.0.0.1', port: proxy.port });

  onTestFinished(() => {
    fresh.stop();
  });

  const answer = await fresh.sendRequest('session.spawn');

  expect(answer).toStrictEqual({ m: 'session.spawn' });
});

test('it swallows the answer to a cut request and leaves the connection open in hold mode', async () => {
  await using ctx = setupTest();

  const proxy = startCutProxy({
    target: { hostname: '127.0.0.1', port: ctx.port },
    method: 'session.spawn',
    cuts: 1,
    mode: 'hold',
  });

  onTestFinished(() => {
    proxy.stop();
  });

  const client = await DaemonClient.open({ hostname: '127.0.0.1', port: proxy.port });

  onTestFinished(() => {
    client.stop();
  });

  let closed = false;

  client.onClose = () => {
    closed = true;
  };

  const reply = client.sendRequest('session.spawn');

  await waitFor(() => {
    expect(proxy.countHeld()).toBe(1);
  });

  const raced = await Promise.race([reply, Promise.resolve('pending')]);

  expect({ raced, closed, seen: ctx.seen }).toStrictEqual({
    raced: 'pending',
    closed: false,
    seen: ['session.spawn'],
  });
});

test('it closes the connection in place of forwarding a cut request in drop mode, so the target never sees it', async () => {
  await using ctx = setupTest();

  const proxy = startCutProxy({
    target: { hostname: '127.0.0.1', port: ctx.port },
    method: 'session.spawn',
    cuts: 1,
    mode: 'drop',
  });

  onTestFinished(() => {
    proxy.stop();
  });

  const client = await DaemonClient.open({ hostname: '127.0.0.1', port: proxy.port });

  onTestFinished(() => {
    client.stop();
  });

  // A request that got through first proves the link to the target is
  // open, so a forwarded request would have reached it.
  await client.sendRequest('daemon.ping');

  const closed = Promise.withResolvers<void>();

  client.onClose = () => {
    closed.resolve();
  };

  const reply = client.sendRequest('session.spawn');

  await closed.promise;

  expect(reply).rejects.toMatchObject({ code: 'internal' });
  expect(ctx.seen).toStrictEqual(['daemon.ping']);
  expect(proxy.countRequests()).toBe(1);
});
