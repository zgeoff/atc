import { expect, onTestFinished, test } from 'bun:test';
import { registerTestCleanup } from './register-test-cleanup';
import { startStubImpd } from './start-stub-impd';
import { waitFor } from './wait-for';

test('it answers a call as system info until the caller sets an answer for its path', async () => {
  const impd = startStubImpd();

  const response = await fetch(`${impd.url}/rpc/system/info`, { method: 'POST', body: '{}' });
  const body: unknown = await response.json();

  expect(body).toStrictEqual({
    json: { features: { sessionOffsets: true, leases: true } },
  });
});

test('it answers a call with the answer the caller set for its path', async () => {
  const impd = startStubImpd();

  impd.answers.set('/rpc/grants/list', { status: 404, json: { code: 'NOT_FOUND' } });

  const response = await fetch(`${impd.url}/rpc/grants/list`, { method: 'POST', body: '{}' });

  expect({ status: response.status, body: await response.json() }).toStrictEqual({
    status: 404,
    body: { json: { code: 'NOT_FOUND' } },
  });
});

test('it records the authorization header and the input of each call', async () => {
  const impd = startStubImpd();

  await fetch(`${impd.url}/rpc/grants/add`, {
    method: 'POST',
    headers: { authorization: 'Bearer t' },
    body: JSON.stringify({ json: { name: 'atc-s1' } }),
  });

  expect(impd.authorizations).toStrictEqual(['Bearer t']);
  expect(impd.calls).toStrictEqual([{ path: '/rpc/grants/add', input: { name: 'atc-s1' } }]);
});

test('it refuses an exec open as a start whose broker is not ready', async () => {
  const impd = startStubImpd();

  const socket = new WebSocket(`${impd.url.replace('http', 'ws')}/exec`);

  registerTestCleanup(() => {
    socket.close();
  });

  const answered = Promise.withResolvers<unknown>();

  socket.addEventListener('open', () => {
    socket.send(JSON.stringify({ type: 'start', name: 'imp-a' }));
  });

  socket.addEventListener('message', (event) => {
    answered.resolve(JSON.parse(String(event.data)));
  });

  const answer = await answered.promise;

  expect(answer).toStrictEqual({
    type: 'error',
    code: 'PRECONDITION_FAILED',
    message: 'the broker is not ready',
    data: { reason: 'broker_not_ready', detail: 'the broker CA did not install' },
  });

  expect(impd.execOpens).toStrictEqual([{ type: 'start', name: 'imp-a' }]);
});

test('it counts the stdin bytes of a started exec once stdin ends', async () => {
  const impd = startStubImpd();

  impd.exec.reply = 'count';

  const socket = new WebSocket(`${impd.url.replace('http', 'ws')}/exec`);

  registerTestCleanup(() => {
    socket.close();
  });

  const frames: unknown[] = [];

  socket.binaryType = 'arraybuffer';

  socket.addEventListener('open', () => {
    socket.send(JSON.stringify({ type: 'start', name: 'imp-a' }));
    socket.send(new Uint8Array([0, 1, 2, 3]));
    socket.send(JSON.stringify({ type: 'stdin_eof' }));
  });

  socket.addEventListener('message', (event) => {
    frames.push(event.data);
  });

  await waitFor(() => {
    expect(frames).toHaveLength(3);
  });

  expect(frames).toStrictEqual([
    JSON.stringify({ type: 'started', pid: 7 }),
    new Uint8Array([1, ...new TextEncoder().encode('3\n')]).buffer,
    JSON.stringify({ type: 'exit', code: 0, signal: null }),
  ]);
});

test('it exits a started exec with code 2 at once when told to exit early', async () => {
  const impd = startStubImpd();

  impd.exec.reply = 'exit-early';

  const socket = new WebSocket(`${impd.url.replace('http', 'ws')}/exec`);

  registerTestCleanup(() => {
    socket.close();
  });

  const frames: unknown[] = [];

  socket.addEventListener('open', () => {
    socket.send(JSON.stringify({ type: 'start', name: 'imp-a' }));
  });

  socket.addEventListener('message', (event) => {
    frames.push(event.data);
  });

  await waitFor(() => {
    expect(frames).toHaveLength(2);
  });

  expect(frames).toStrictEqual([
    JSON.stringify({ type: 'started', pid: 7 }),
    JSON.stringify({ type: 'exit', code: 2, signal: null }),
  ]);
});

test('it answers a tunnel listen as listening and keeps its control socket', async () => {
  const impd = startStubImpd();

  const socket = new WebSocket(`${impd.url.replace('http', 'ws')}/tunnel`);

  registerTestCleanup(() => {
    socket.close();
  });

  const answered = Promise.withResolvers<unknown>();

  socket.addEventListener('open', () => {
    socket.send(JSON.stringify({ type: 'listen' }));
  });

  socket.addEventListener('message', (event) => {
    answered.resolve(JSON.parse(String(event.data)));
  });

  const answer = await answered.promise;

  expect(answer).toStrictEqual({
    type: 'listening',
    listener: 'l1',
    path: '/tmp/r.sock',
    port: null,
  });

  expect<unknown[]>(impd.controls).toStrictEqual([expect.anything()]);
});

test('it records the authorization header of a WebSocket upgrade and no call', async () => {
  const impd = startStubImpd();

  const socket = new WebSocket(`${impd.url.replace('http', 'ws')}/exec`, {
    headers: { authorization: 'Bearer w' },
  });

  registerTestCleanup(() => {
    socket.close();
  });

  const opened = Promise.withResolvers<void>();

  socket.addEventListener('open', () => {
    opened.resolve();
  });

  await opened.promise;

  expect(impd.authorizations).toStrictEqual(['Bearer w']);
  expect(impd.calls).toStrictEqual([]);
});

test('it closes a WebSocket that sends a message over 2 MiB', async () => {
  const impd = startStubImpd();

  const socket = new WebSocket(`${impd.url.replace('http', 'ws')}/exec`);

  registerTestCleanup(() => {
    socket.close();
  });

  const closed = Promise.withResolvers<number>();

  socket.addEventListener('open', () => {
    socket.send(new Uint8Array(2 * 1024 * 1024 + 1));
  });

  socket.addEventListener('close', (event) => {
    closed.resolve(event.code);
  });

  const code = await closed.promise;

  // The server drops the connection without a close frame, which the client
  // reports as an abnormal closure.
  expect(code).toBe(1006);
});

test('it drops an open WebSocket once stopped', async () => {
  const impd = startStubImpd();

  const socket = new WebSocket(`${impd.url.replace('http', 'ws')}/exec`);

  registerTestCleanup(() => {
    socket.close();
  });

  const opened = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<number>();

  socket.addEventListener('open', () => {
    opened.resolve();
  });

  socket.addEventListener('close', (event) => {
    closed.resolve(event.code);
  });

  await opened.promise;

  await impd.stop();

  const code = await closed.promise;

  // Stopping drops the connection at once, without a close frame.
  expect(code).toBe(1006);
});

test('it stops serving once the test finishes without a stop', () => {
  const impd = startStubImpd();

  onTestFinished(() => {
    expect(fetch(`${impd.url}/rpc/system/info`)).rejects.toThrow();
  });
});
