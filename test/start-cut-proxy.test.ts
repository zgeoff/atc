import { expect, onTestFinished, test } from 'bun:test';
import { DaemonClient } from '../src/client/daemon-client';
import { isRecord } from '../src/shared/report';
import { startCutProxy } from './start-cut-proxy';

/**
 * A line server on a loopback port that answers every request line with
 * an ok holding the request's method, and counts the requests it got.
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
          const request: unknown = JSON.parse(line);
          const id = isRecord(request) ? request['id'] : null;
          const m = isRecord(request) ? String(request['m']) : '';

          seen.push(m);
          socket.write(`${JSON.stringify({ v: 4, id, ok: { m } })}\n`);
        }
      },
      error() {},
    },
  });

  return {
    port: server.port,
    seen,
    [Symbol.dispose]() {
      server.stop(true);
    },
  };
}

test('it forwards requests and answers of other methods unchanged', async () => {
  using target = setupTest();

  const proxy = startCutProxy({
    target: { hostname: '127.0.0.1', port: target.port },
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
  using target = setupTest();

  const proxy = startCutProxy({
    target: { hostname: '127.0.0.1', port: target.port },
    method: 'session.spawn',
    cuts: 1,
    mode: 'close',
  });

  onTestFinished(() => {
    proxy.stop();
  });

  const client = await DaemonClient.open({ hostname: '127.0.0.1', port: proxy.port });

  const closed = Promise.withResolvers<void>();

  client.onClose = () => {
    closed.resolve();
  };

  expect(client.sendRequest('session.spawn')).rejects.toMatchObject({ code: 'internal' });

  await closed.promise;

  expect(target.seen).toStrictEqual(['session.spawn']);
  expect(proxy.countRequests()).toBe(1);
});

test('it forwards the answer once its cuts are spent', async () => {
  using target = setupTest();

  const proxy = startCutProxy({
    target: { hostname: '127.0.0.1', port: target.port },
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

  expect(cut.sendRequest('session.spawn')).rejects.toMatchObject({ code: 'internal' });

  const fresh = await DaemonClient.open({ hostname: '127.0.0.1', port: proxy.port });

  onTestFinished(() => {
    fresh.stop();
  });

  const answer = await fresh.sendRequest('session.spawn');

  expect(answer).toStrictEqual({ m: 'session.spawn' });
});

test('it swallows the answer to a cut request and leaves the connection open in hold mode', async () => {
  using target = setupTest();

  const proxy = startCutProxy({
    target: { hostname: '127.0.0.1', port: target.port },
    method: 'session.spawn',
    cuts: 1,
    mode: 'hold',
  });

  onTestFinished(() => {
    proxy.stop();
  });

  const client = await DaemonClient.open({ hostname: '127.0.0.1', port: proxy.port });

  let closed = false;

  client.onClose = () => {
    closed = true;
  };

  onTestFinished(() => {
    client.stop();
  });

  const answered = (async () => {
    await client.sendRequest('session.spawn');

    return 'answered';
  })();

  const silent = (async () => {
    // No signal marks an answer that never comes; this waits out the time
    // an answer from a local server takes.
    await Bun.sleep(300);

    return 'silent';
  })();

  const raced = await Promise.race([answered, silent]);

  expect(raced).toBe('silent');
  expect(closed).toBeFalse();
  expect(target.seen).toStrictEqual(['session.spawn']);
});
