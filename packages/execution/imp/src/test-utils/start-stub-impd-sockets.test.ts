import { expect, onTestFinished, test } from 'bun:test';
import { registerTestCleanup } from '@atc/core/test-utils/register-test-cleanup';
import { waitFor } from '@atc/core/test-utils/wait-for';
import { TEST_TOKEN, startTestImpd } from '@impz/testing';
import { startStubImpdSockets } from './start-stub-impd-sockets';

test('it refuses an exec open as a start whose broker is not ready', async () => {
  const impd = startStubImpdSockets();

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
  const impd = startStubImpdSockets();

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
  const impd = startStubImpdSockets();

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
  const impd = startStubImpdSockets();

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

test('it answers a relay accept as opened and keeps its relay socket', async () => {
  const impd = startStubImpdSockets();

  const socket = new WebSocket(`${impd.url.replace('http', 'ws')}/tunnel`);

  registerTestCleanup(() => {
    socket.close();
  });

  const answered = Promise.withResolvers<unknown>();

  socket.addEventListener('open', () => {
    socket.send(JSON.stringify({ type: 'accept', name: 'imp-a', listener: 'l1', connection: 1 }));
  });

  socket.addEventListener('message', (event) => {
    answered.resolve(JSON.parse(String(event.data)));
  });

  const answer = await answered.promise;

  expect(answer).toStrictEqual({ type: 'opened' });
  expect<unknown[]>(impd.relays).toStrictEqual([expect.anything()]);
  expect(impd.controls).toBeEmpty();
});

test('it records the authorization header of a WebSocket upgrade', async () => {
  const impd = startStubImpdSockets();

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
});

test('it closes a WebSocket that sends a message over 2 MiB', async () => {
  const impd = startStubImpdSockets();

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

  // The server closes the connection with the code for a message too big.
  expect(code).toBe(1009);
});

test('it drops an open WebSocket once stopped', async () => {
  const impd = startStubImpdSockets();

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

  // 1001 is the WebSocket close code for an endpoint going away (RFC 6455), which a server
  // sends when it shuts down.
  expect(code).toBe(1001);
});

test('it stops serving once the test finishes without a stop', () => {
  const impd = startStubImpdSockets();

  onTestFinished(() => {
    expect(fetch(`${impd.url}/rpc/system/info`)).rejects.toThrow();
  });
});

test('it sends a request that is no socket to the upstream impd and returns its answer', async () => {
  const upstream = await startTestImpd({ version: '3.1.0' });

  onTestFinished(upstream.stop);

  const impd = startStubImpdSockets({ upstreamUrl: upstream.url });

  const response = await fetch(`${impd.url}/rpc/system/info`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TEST_TOKEN}`, 'content-type': 'application/json' },
    body: '{}',
  });

  const body = await response.json();

  expect(body).toMatchObject({ json: { version: '3.1.0' } });
  expect(upstream.calls.map((call) => call.procedure)).toStrictEqual(['system/info']);
});

test('it answers a request that is no socket with 404 when it has no upstream impd', async () => {
  const impd = startStubImpdSockets();

  const response = await fetch(`${impd.url}/rpc/system/info`, { method: 'POST', body: '{}' });

  expect(response.status).toBe(404);
});
