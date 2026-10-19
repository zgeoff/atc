import { expect, onTestFinished, test } from 'bun:test';
import { openDaemonClient } from '@atc/protocol/client';
import { registerTestCleanup } from './register-test-cleanup';
import { startCutProxy } from './start-cut-proxy';
import { startStubTCPDaemon } from './start-stub-tcp-daemon';
import { waitFor } from './wait-for';

// The stand-in daemon the proxy forwards to.
function setupTest() {
  const daemon = startStubTCPDaemon();

  return { port: daemon.port, seen: daemon.seen };
}

test('it forwards requests and answers of other methods unchanged', async () => {
  const ctx = setupTest();

  const proxy = startCutProxy({
    target: { hostname: '127.0.0.1', port: ctx.port },
    method: 'session.spawn',
    cuts: 1,
    mode: 'close',
  });

  const client = await openDaemonClient({ hostname: '127.0.0.1', port: proxy.port });

  registerTestCleanup(() => {
    client.stop();
  });

  const answer = await client.sendRequest('session.list');

  expect(answer).toStrictEqual({ m: 'session.list' });
});

test('it closes the connection in place of the answer to a cut request that reached the target', async () => {
  const ctx = setupTest();

  const proxy = startCutProxy({
    target: { hostname: '127.0.0.1', port: ctx.port },
    method: 'session.spawn',
    cuts: 1,
    mode: 'close',
  });

  const client = await openDaemonClient({ hostname: '127.0.0.1', port: proxy.port });

  registerTestCleanup(() => {
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

test('it forwards the lines the target sends ahead of the cut answer, and only the answer is lost', async () => {
  const target = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      data(socket) {
        socket.write('{"i":"1","t":3,"p":{"e":"message","d":{"ev":"SessionAdded"}}}\n');
        socket.write('{"i":"7","p":{"b":{"json":{"session":{"id":"s-1"}}}}}\n');
      },
    },
  });

  registerTestCleanup(() => {
    target.stop(true);
  });

  const proxy = startCutProxy({
    target: { hostname: '127.0.0.1', port: target.port },
    method: 'session.spawn',
    cuts: 1,
    mode: 'close',
  });

  const received: string[] = [];
  const closed = Promise.withResolvers<void>();

  const raw = await Bun.connect({
    hostname: '127.0.0.1',
    port: proxy.port,
    socket: {
      data(_socket, buf) {
        received.push(buf.toString());
      },
      close() {
        closed.resolve();
      },
    },
  });

  registerTestCleanup(() => {
    raw.end();
  });

  raw.write('{"i":"7","p":{"u":"/session/spawn","b":{"json":{}}}}\n');

  await closed.promise;

  expect(received.join('')).toBe('{"i":"1","t":3,"p":{"e":"message","d":{"ev":"SessionAdded"}}}\n');
});

test('it forwards the answer once its cuts are spent', async () => {
  const ctx = setupTest();

  const proxy = startCutProxy({
    target: { hostname: '127.0.0.1', port: ctx.port },
    method: 'session.spawn',
    cuts: 1,
    mode: 'close',
  });

  const cut = await openDaemonClient({ hostname: '127.0.0.1', port: proxy.port });

  registerTestCleanup(() => {
    cut.stop();
  });

  const cutReply = cut.sendRequest('session.spawn');

  await Promise.allSettled([cutReply]);

  const fresh = await openDaemonClient({ hostname: '127.0.0.1', port: proxy.port });

  registerTestCleanup(() => {
    fresh.stop();
  });

  const answer = await fresh.sendRequest('session.spawn');

  expect(cutReply).rejects.toMatchObject({ code: 'internal' });
  expect(answer).toStrictEqual({ m: 'session.spawn' });
});

test('it swallows the answer to a cut request and leaves the connection open in hold mode', async () => {
  const ctx = setupTest();

  const proxy = startCutProxy({
    target: { hostname: '127.0.0.1', port: ctx.port },
    method: 'session.spawn',
    cuts: 1,
    mode: 'hold',
  });

  const client = await openDaemonClient({ hostname: '127.0.0.1', port: proxy.port });

  registerTestCleanup(() => {
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

  expect(raced).toBe('pending');
  expect(closed).toBe(false);
  expect(ctx.seen).toStrictEqual(['session.spawn']);
});

test('it closes the connection in place of forwarding a cut request in drop mode, so the target never sees it', async () => {
  const ctx = setupTest();

  const proxy = startCutProxy({
    target: { hostname: '127.0.0.1', port: ctx.port },
    method: 'session.spawn',
    cuts: 1,
    mode: 'drop',
  });

  const client = await openDaemonClient({ hostname: '127.0.0.1', port: proxy.port });

  registerTestCleanup(() => {
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

test('it stops listening once the test finishes without a stop', () => {
  const proxy = startCutProxy({
    target: { hostname: '127.0.0.1', port: 1 },
    method: 'session.list',
    cuts: 0,
    mode: 'close',
  });

  onTestFinished(() => {
    expect(
      Bun.connect({ hostname: '127.0.0.1', port: proxy.port, socket: { data() {} } }),
    ).rejects.toThrow();
  });
});

test('it stops listening once stopped', () => {
  const proxy = startCutProxy({
    target: { hostname: '127.0.0.1', port: 1 },
    method: 'session.list',
    cuts: 0,
    mode: 'close',
  });

  proxy.stop();

  expect(
    Bun.connect({ hostname: '127.0.0.1', port: proxy.port, socket: { data() {} } }),
  ).rejects.toThrow();
});
