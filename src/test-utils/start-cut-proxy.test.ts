import { expect, onTestFinished, test } from 'bun:test';
import { DaemonClient } from '../client/daemon-client';
import { startCutProxy } from './start-cut-proxy';
import { startStubTCPDaemon } from './start-stub-tcp-daemon';
import { waitFor } from './wait-for';

// The stand-in daemon the proxy forwards to.
function setupTest() {
  return startStubTCPDaemon();
}

test('it forwards requests and answers of other methods unchanged', async () => {
  using ctx = setupTest();

  using proxy = startCutProxy({
    target: { hostname: '127.0.0.1', port: ctx.port },
    method: 'session.spawn',
    cuts: 1,
    mode: 'close',
  });

  const client = await DaemonClient.open({ hostname: '127.0.0.1', port: proxy.port });

  onTestFinished(() => {
    client.stop();
  });

  const answer = await client.sendRequest('session.list');

  expect(answer).toStrictEqual({ m: 'session.list' });
});

test('it closes the connection in place of the answer to a cut request that reached the target', async () => {
  using ctx = setupTest();

  using proxy = startCutProxy({
    target: { hostname: '127.0.0.1', port: ctx.port },
    method: 'session.spawn',
    cuts: 1,
    mode: 'close',
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
  using ctx = setupTest();

  using proxy = startCutProxy({
    target: { hostname: '127.0.0.1', port: ctx.port },
    method: 'session.spawn',
    cuts: 1,
    mode: 'close',
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
  using ctx = setupTest();

  using proxy = startCutProxy({
    target: { hostname: '127.0.0.1', port: ctx.port },
    method: 'session.spawn',
    cuts: 1,
    mode: 'hold',
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
  using ctx = setupTest();

  using proxy = startCutProxy({
    target: { hostname: '127.0.0.1', port: ctx.port },
    method: 'session.spawn',
    cuts: 1,
    mode: 'drop',
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

test('it stops listening once the test finishes without a dispose', () => {
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

test('it stops listening once disposed', () => {
  const proxy = startCutProxy({
    target: { hostname: '127.0.0.1', port: 1 },
    method: 'session.list',
    cuts: 0,
    mode: 'close',
  });

  proxy[Symbol.dispose]();

  expect(
    Bun.connect({ hostname: '127.0.0.1', port: proxy.port, socket: { data() {} } }),
  ).rejects.toThrow();
});
