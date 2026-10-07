import { expect, test } from 'bun:test';
import { startStubImpd } from './start-stub-impd';
import { waitFor } from './wait-for';

test('it answers a call as system info until the caller sets an answer for its path', async () => {
  using impd = startStubImpd();

  const response = await fetch(`${impd.url}/rpc/system/info`, { method: 'POST', body: '{}' });
  const body: unknown = await response.json();

  expect(body).toStrictEqual({
    json: { features: { sessionOffsets: true, leases: true } },
  });
});

test('it answers a call with the answer the caller set for its path', async () => {
  using impd = startStubImpd();

  impd.answers.set('/rpc/grants/list', { status: 404, json: { code: 'NOT_FOUND' } });

  const response = await fetch(`${impd.url}/rpc/grants/list`, { method: 'POST', body: '{}' });

  expect({ status: response.status, body: await response.json() }).toStrictEqual({
    status: 404,
    body: { json: { code: 'NOT_FOUND' } },
  });
});

test('it records the authorization header and the input of each call', async () => {
  using impd = startStubImpd();

  await fetch(`${impd.url}/rpc/grants/add`, {
    method: 'POST',
    headers: { authorization: 'Bearer t' },
    body: JSON.stringify({ json: { name: 'atc-s1' } }),
  });

  expect({ authorizations: impd.authorizations, calls: impd.calls }).toStrictEqual({
    authorizations: ['Bearer t'],
    calls: [{ path: '/rpc/grants/add', input: { name: 'atc-s1' } }],
  });
});

test('it refuses an exec open as a start whose broker is not ready', async () => {
  using impd = startStubImpd();

  const socket = new WebSocket(`${impd.url.replace('http', 'ws')}/exec`);

  const answered = Promise.withResolvers<unknown>();

  socket.addEventListener('open', () => {
    socket.send(JSON.stringify({ type: 'start', name: 'imp-a' }));
  });

  socket.addEventListener('message', (event) => {
    answered.resolve(JSON.parse(String(event.data)));
  });

  const answer = await answered.promise;

  socket.close();

  expect({ answer, opens: impd.execOpens }).toStrictEqual({
    answer: {
      type: 'error',
      code: 'PRECONDITION_FAILED',
      message: 'the broker is not ready',
      data: { reason: 'broker_not_ready', detail: 'the broker CA did not install' },
    },
    opens: [{ type: 'start', name: 'imp-a' }],
  });
});

test('it counts the stdin bytes of a started exec once stdin ends', async () => {
  using impd = startStubImpd();

  impd.exec.reply = 'count';

  const socket = new WebSocket(`${impd.url.replace('http', 'ws')}/exec`);

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

  socket.close();

  expect(frames).toStrictEqual([
    JSON.stringify({ type: 'started', pid: 7 }),
    new Uint8Array([1, ...new TextEncoder().encode('3\n')]).buffer,
    JSON.stringify({ type: 'exit', code: 0, signal: null }),
  ]);
});

test('it exits a started exec with code 2 at once when told to exit early', async () => {
  using impd = startStubImpd();

  impd.exec.reply = 'exit-early';

  const socket = new WebSocket(`${impd.url.replace('http', 'ws')}/exec`);

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

  socket.close();

  expect(frames).toStrictEqual([
    JSON.stringify({ type: 'started', pid: 7 }),
    JSON.stringify({ type: 'exit', code: 2, signal: null }),
  ]);
});

test('it answers a tunnel listen as listening and keeps its control socket', async () => {
  using impd = startStubImpd();

  const socket = new WebSocket(`${impd.url.replace('http', 'ws')}/tunnel`);

  const answered = Promise.withResolvers<unknown>();

  socket.addEventListener('open', () => {
    socket.send(JSON.stringify({ type: 'listen' }));
  });

  socket.addEventListener('message', (event) => {
    answered.resolve(JSON.parse(String(event.data)));
  });

  const answer = await answered.promise;

  socket.close();

  expect<Record<string, unknown>>({ answer, controls: impd.controls }).toStrictEqual({
    answer: { type: 'listening', listener: 'l1', path: '/tmp/r.sock', port: null },
    controls: [expect.anything()],
  });
});
