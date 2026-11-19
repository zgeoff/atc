import { expect, onTestFinished, spyOn, test } from 'bun:test';
import { AtcError } from '@atcx/contract/light';
import { startStubDaemon } from '../test-utils/start-stub-daemon';
import type { StubDaemonOptions } from '../test-utils/start-stub-daemon';
import { waitUntil } from '../test-utils/wait-until';
import { openDaemonConnection } from './open-daemon-connection';

async function setupTest(options: StubDaemonOptions = {}) {
  const daemon = await startStubDaemon(options);

  onTestFinished(daemon.stop);

  return {
    daemon,
    target: { path: daemon.path },
    open: async () => {
      const connection = await openDaemonConnection(
        { path: daemon.path },
        { client: 'stu-watcher' },
      );

      onTestFinished(connection.close);

      return connection;
    },
  };
}

test('it resolves with the hello answer once the daemon accepts the hello', async () => {
  const ctx = await setupTest({ features: ['events.read.from-start'] });
  const connection = await ctx.open();

  expect(connection.hello.daemon).toBe('atc/stub');
  expect(ctx.daemon.requests.map((request) => request.method)).toStrictEqual(['daemon.hello']);

  expect(ctx.daemon.requests[0]?.params).toMatchObject({
    client: 'stu-watcher',
    protocol: 15,
    auth: { scheme: 'none' },
  });
});

test('it sends the same call by its method name and through the typed procedures', async () => {
  const ctx = await setupTest({
    answer: (request) => ({ ok: request.method === 'session.list' ? { sessions: [] } : {} }),
  });

  const connection = await ctx.open();
  const byName = await connection.request('session.list', {});
  const typed = await connection.procedures.session.list({});

  expect(byName).toStrictEqual({ sessions: [] });
  expect(typed).toStrictEqual({ sessions: [] });
});

test('it acts as the hello principal unless a call names another', async () => {
  const ctx = await setupTest();

  const connection = await openDaemonConnection(
    ctx.target,
    { client: 'stu-watcher', principal: 'alice' },
    {},
  );

  onTestFinished(connection.close);

  await connection.request('session.list', {});
  await connection.request('session.list', {}, { as: 'bob', asName: 'Bob' });

  const calls = ctx.daemon.requests.slice(1).map((request) => [request.as, request.asName]);

  expect(calls).toStrictEqual([
    ['alice', undefined],
    ['bob', 'Bob'],
  ]);
});

test('it shows each answer to onAnswer before its call resolves', async () => {
  const ctx = await setupTest({ answer: () => ({ ok: { sessions: [] } }) });

  const seen: string[] = [];

  const connection = await openDaemonConnection(
    ctx.target,
    { client: 'stu-watcher' },
    {
      onAnswer: (method) => {
        seen.push(method);
      },
    },
  );

  onTestFinished(connection.close);

  await connection.request('session.list', {});

  expect(seen).toStrictEqual(['daemon.hello', 'session.list']);
});

test('it throws the daemon refusal of the hello with its code and data, and closes the socket', async () => {
  const ctx = await setupTest({
    hello: () => ({
      err: { code: 'protocol_mismatch', message: 'wrong major', data: { daemonMajor: 8 } },
    }),
  });

  const opening = openDaemonConnection(ctx.target, { client: 'stu-watcher' });

  expect(opening).rejects.toMatchObject({ code: 'protocol_mismatch', data: { daemonMajor: 8 } });

  await Promise.allSettled([opening]);

  await waitUntil(() => {
    expect(ctx.daemon.openConnections).toBe(0);
  });
});

test('it throws protocol_mismatch with no data when the daemon answers with a line that is no peer message', async () => {
  const ctx = await setupTest({
    hello: () => ({ line: '{"version":14,"id":1,"err":{"code":"protocol_mismatch"}}' }),
  });

  expect(openDaemonConnection(ctx.target, { client: 'stu-watcher' })).rejects.toMatchObject({
    code: 'protocol_mismatch',
    data: {},
  });
});

test('it throws timeout with the limit when the hello takes longer than timeoutMs', async () => {
  const ctx = await setupTest({ hello: () => 'silent' });

  const opening = openDaemonConnection(ctx.target, { client: 'stu-watcher' }, { timeoutMs: 50 });

  expect(opening).rejects.toMatchObject({ code: 'timeout', data: { timeoutMs: 50 } });

  await Promise.allSettled([opening]);

  await waitUntil(() => {
    expect(ctx.daemon.openConnections).toBe(0);
  });
});

test('it rejects with the signal reason and leaves no open socket when the signal aborts first', async () => {
  const ctx = await setupTest({ hello: () => 'silent' });

  const controller = new AbortController();
  const reason = new Error('the caller gave up');

  const opening = openDaemonConnection(
    ctx.target,
    { client: 'stu-watcher' },
    { signal: controller.signal },
  );

  const settled = Promise.allSettled([opening]);

  await waitUntil(() => {
    expect(ctx.daemon.requests).toHaveLength(1);
  });

  controller.abort(reason);

  await settled;

  expect(opening).rejects.toBe(reason);

  await waitUntil(() => {
    expect(ctx.daemon.openConnections).toBe(0);
  });
});

test('it closes the connection when the signal aborts after the hello', async () => {
  const ctx = await setupTest();

  const controller = new AbortController();

  const connection = await openDaemonConnection(
    ctx.target,
    { client: 'stu-watcher' },
    { signal: controller.signal },
  );

  controller.abort();

  await connection.closed;

  await waitUntil(() => {
    expect(ctx.daemon.openConnections).toBe(0);
  });
});

test('it throws no_daemon with the path when nothing listens there', () => {
  const opening = openDaemonConnection(
    { path: '/nonexistent/atc.sock' },
    { client: 'stu-watcher' },
  );

  expect(opening).rejects.toMatchObject({
    code: 'no_daemon',
    data: { tried: ['/nonexistent/atc.sock'] },
  });
});

test('it fails a call that needs a feature the daemon lacks, and sends nothing', async () => {
  const ctx = await setupTest({ features: [] });
  const connection = await ctx.open();

  const calling = connection.request('events.read', { from: 'start' });

  expect(calling).rejects.toMatchObject({ code: 'feature_missing' });

  await Promise.allSettled([calling]);

  expect(ctx.daemon.requests.map((request) => request.method)).toStrictEqual(['daemon.hello']);
});

test('it rejects a pending call with connection_lost, readOnly and keyed when the socket drops', async () => {
  const ctx = await setupTest({ answer: () => 'silent' });
  const connection = await ctx.open();

  const reading = connection.request('session.list', {});

  const writing = connection.request('session.message', {
    session: 's_1',
    text: 'hi',
    idempotencyKey: 'k1',
  });

  const settled = Promise.allSettled([reading, writing]);

  await waitUntil(() => {
    expect(ctx.daemon.requests).toHaveLength(3);
  });

  ctx.daemon.dropConnections();

  await settled;

  expect(reading).rejects.toMatchObject({
    code: 'connection_lost',
    data: { procedure: 'session.list', readOnly: true, keyed: false },
  });

  expect(writing).rejects.toMatchObject({
    code: 'connection_lost',
    data: { procedure: 'session.message', readOnly: false, keyed: true },
  });
});

test('it ends every events iterator and settles closed when the socket drops', async () => {
  const ctx = await setupTest();
  const connection = await ctx.open();

  const first = connection.events()[Symbol.asyncIterator]();
  const second = connection.events()[Symbol.asyncIterator]();

  await waitUntil(() => {
    expect(ctx.daemon.subscriptions).toBe(1);
  });

  ctx.daemon.dropConnections();

  const ends = await Promise.all([first.next(), second.next()]);

  expect(ends).toStrictEqual([
    { done: true, value: undefined },
    { done: true, value: undefined },
  ]);

  expect(connection.closed).resolves.toBeUndefined();
});

test('it rejects a call on a closed connection with connection_lost and sends nothing', async () => {
  const ctx = await setupTest();
  const connection = await ctx.open();

  await connection.close();

  const calling = connection.request('session.list', {});

  expect(calling).rejects.toMatchObject({ code: 'connection_lost' });

  await Promise.allSettled([calling]);

  expect(ctx.daemon.requests.map((request) => request.method)).toStrictEqual(['daemon.hello']);
});

test('it rejects pending calls at once when close is called, and a second close resolves', async () => {
  const ctx = await setupTest({ answer: () => 'silent' });
  const connection = await ctx.open();

  const pending = connection.request('session.list', {});
  const settled = Promise.allSettled([pending]);

  await waitUntil(() => {
    expect(ctx.daemon.requests).toHaveLength(2);
  });

  await connection.close();

  await settled;

  expect(pending).rejects.toMatchObject({ code: 'connection_lost' });
  expect(connection.close()).resolves.toBeUndefined();
});

test('it opens one event subscription for every iterator and gives each the events from its start', async () => {
  const ctx = await setupTest();
  const connection = await ctx.open();

  const first = connection.events()[Symbol.asyncIterator]();

  await waitUntil(() => {
    expect(ctx.daemon.subscriptions).toBe(1);
  });

  ctx.daemon.emit({ ev: 'SessionRemoved', sessionID: 's_1' });

  await first.next();

  const second = connection.events()[Symbol.asyncIterator]();

  ctx.daemon.emit({ ev: 'SessionRemoved', sessionID: 's_2' });

  const next = await Promise.all([first.next(), second.next()]);

  expect(next).toStrictEqual([
    { done: false, value: { ev: 'SessionRemoved', sessionID: 's_2' } },
    { done: false, value: { ev: 'SessionRemoved', sessionID: 's_2' } },
  ]);

  expect(ctx.daemon.subscriptions).toBe(1);
});

test('it ends one iterator by its signal and leaves the others running', async () => {
  const ctx = await setupTest();
  const connection = await ctx.open();

  const controller = new AbortController();

  const stopped = connection.events({ signal: controller.signal })[Symbol.asyncIterator]();
  const running = connection.events()[Symbol.asyncIterator]();

  await waitUntil(() => {
    expect(ctx.daemon.subscriptions).toBe(1);
  });

  controller.abort();
  ctx.daemon.emit({ ev: 'SessionRemoved', sessionID: 's_1' });

  const results = await Promise.all([stopped.next(), running.next()]);

  expect(results).toStrictEqual([
    { done: true, value: undefined },
    { done: false, value: { ev: 'SessionRemoved', sessionID: 's_1' } },
  ]);
});

test('it skips an event of a kind the contract does not hold', async () => {
  const ctx = await setupTest();
  const connection = await ctx.open();

  const events = connection.events()[Symbol.asyncIterator]();

  await waitUntil(() => {
    expect(ctx.daemon.subscriptions).toBe(1);
  });

  ctx.daemon.emit({ ev: 'FromALaterRelease', sessionID: 's_1' });
  ctx.daemon.emit({ ev: 'SessionRemoved', sessionID: 's_2' });

  const next = await events.next();

  expect(next).toStrictEqual({
    done: false,
    value: { ev: 'SessionRemoved', sessionID: 's_2' },
  });
});

test('it ends one iterator with events_overflow when it falls 10000 events behind, and the others carry on', async () => {
  const ctx = await setupTest();
  const connection = await ctx.open();

  const lagging = connection.events()[Symbol.asyncIterator]();
  const reading = connection.events()[Symbol.asyncIterator]();

  await waitUntil(() => {
    expect(ctx.daemon.subscriptions).toBe(1);
  });

  const draining = (async () => {
    for (let read = 0; read < 10_001; read += 1) {
      await reading.next();
    }
  })();

  for (let index = 0; index <= 10_000; index += 1) {
    ctx.daemon.emit({ ev: 'SessionRemoved', sessionID: `s_${index}` });
  }

  await draining;

  expect(lagging.next()).rejects.toMatchObject({ code: 'events_overflow', data: {} });

  ctx.daemon.emit({ ev: 'SessionRemoved', sessionID: 's_last' });

  const last = await reading.next();

  expect(last).toStrictEqual({
    done: false,
    value: { ev: 'SessionRemoved', sessionID: 's_last' },
  });
});

test('it never puts the token in an error message, an error data, a stack or a log line', async () => {
  const token = 'example-bearer-token';
  const logged: string[] = [];

  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    const spy = spyOn(console, method).mockImplementation((...parts: unknown[]) => {
      logged.push(parts.map(String).join(' '));
    });

    onTestFinished(() => {
      spy.mockRestore();
    });
  }

  const refusing = await setupTest({
    hello: () => ({ err: { code: 'unauthorized', message: 'the token is not accepted' } }),
  });

  const silent = await setupTest({ hello: () => 'silent' });
  const legacy = await setupTest({ hello: () => ({ line: 'not a peer message' }) });
  const dropping = await setupTest({ answer: () => 'silent' });

  const hello = { client: 'c', token, principal: 'p' };

  const connection = await openDaemonConnection(dropping.target, hello);

  const lost = connection.request('session.list', {});
  const early = Promise.allSettled([lost]);

  await waitUntil(() => {
    expect(dropping.daemon.requests).toHaveLength(2);
  });

  dropping.daemon.dropConnections();

  const settled = await Promise.allSettled([
    openDaemonConnection(refusing.target, hello),
    openDaemonConnection(silent.target, hello, { timeoutMs: 50 }),
    openDaemonConnection(legacy.target, hello),
    openDaemonConnection({ path: `${silent.daemon.path}.missing` }, hello),
    lost,
    early,
  ]);

  const failures = settled.flatMap((result) =>
    result.status === 'rejected' && result.reason instanceof AtcError ? [result.reason] : [],
  );

  const texts = failures.flatMap((failure) => [
    failure.message,
    JSON.stringify(failure.data),
    failure.stack,
  ]);

  expect(failures).toHaveLength(5);
  expect([...texts, ...logged]).toSatisfyAll((text: string) => !text.includes(token));
  expect(dropping.daemon.requests[0]?.params).toMatchObject({ auth: { scheme: 'bearer', token } });
});

test('it ends the connection and rejects each pending call when a write would pass 8 MiB', async () => {
  const ctx = await setupTest({ answer: () => 'silent' });
  const connection = await ctx.open();

  const pending = connection.request('session.list', {});

  await waitUntil(() => {
    expect(ctx.daemon.requests).toHaveLength(2);
  });

  const oversized = connection.request('session.message', {
    session: 's_1',
    text: 'x'.repeat(9 * 1024 * 1024),
  });

  await Promise.allSettled([oversized, pending]);

  await connection.closed;

  expect(oversized).rejects.toMatchObject({ code: 'connection_lost' });
  expect(pending).rejects.toMatchObject({ code: 'connection_lost' });
});

test('it delivers a message that is larger than one socket write', async () => {
  const text = 'y'.repeat(4 * 1024 * 1024);
  let received = 0;

  const ctx = await setupTest({
    answer: (request) => {
      received = String(request.params['text']).length;

      return { ok: { delivered: true } };
    },
  });

  const connection = await ctx.open();

  await connection.request('session.message', { session: 's_1', text });

  expect(received).toBe(text.length);
});
