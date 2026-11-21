import { expect, onTestFinished, test } from 'bun:test';
import { waitFor } from '@zgeoff/testing';
import { openExecConnection } from './open-exec-connection';
import type { ExecEnd } from './types';

function setupTest() {
  const urls: string[] = [];
  const authorizations: (string | null)[] = [];
  const received: Uint8Array[] = [];

  const answerRequest = (request: Request, upgrading: Bun.Server<undefined>) => {
    urls.push(request.url);
    authorizations.push(request.headers.get('authorization'));

    return upgrading.upgrade(request) ? undefined : new Response('no upgrade', { status: 400 });
  };

  const server = Bun.serve({
    port: 0,
    fetch: answerRequest,
    websocket: {
      open: (socket) => {
        socket.send(JSON.stringify({ type: 'session_info', session_id: '1847', tty: false }));
        socket.send(new Uint8Array([1, 104, 105]));
        socket.send(new Uint8Array([2, 111, 112]));
      },
      message: (socket, message) => {
        if (typeof message !== 'string') {
          received.push(new Uint8Array(message));
        }

        if (typeof message !== 'string' && message[0] === 4) {
          socket.send(new Uint8Array([3, 7]));
        }
      },
    },
  });

  onTestFinished(async () => {
    await server.stop(true);
  });

  return { apiURL: `http://127.0.0.1:${server.port}`, urls, authorizations, received };
}

test('it starts a command that outlives its clients, with its environment and directory in the URL', async () => {
  const ctx = setupTest();

  const connection = openExecConnection({
    apiURL: ctx.apiURL,
    token: 'secret-token',
    sprite: 'atc-h1',
    request: {
      argv: ['atc', 'relay-mux', '/g/a.sock'],
      cwd: '/g',
      env: { TERM: 'xterm' },
      tty: false,
      outlivesClients: true,
    },
  });

  await connection.execID;

  const url = new URL(ctx.urls[0] ?? '');

  expect([
    url.pathname,
    url.searchParams.getAll('cmd'),
    url.searchParams.get('dir'),
    url.searchParams.getAll('env'),
    url.searchParams.get('max_run_after_disconnect'),
    ctx.authorizations[0],
  ]).toStrictEqual([
    '/v1/sprites/atc-h1/exec',
    ['atc', 'relay-mux', '/g/a.sock'],
    '/g',
    ['TERM=xterm'],
    '8760h',
    'Bearer secret-token',
  ]);

  connection.detach();
});

test('it names the exec by its session id, and reads stdout, stderr and the exit', async () => {
  const ctx = setupTest();
  const stdout: string[] = [];
  const stderr: string[] = [];
  const ends: ExecEnd[] = [];

  const connection = openExecConnection({
    apiURL: ctx.apiURL,
    token: 'secret-token',
    sprite: 'atc-h1',
    request: { argv: ['cat'], tty: false },
  });

  connection.onData((data, stream) => {
    (stream === 'stdout' ? stdout : stderr).push(new TextDecoder().decode(data));
  });

  connection.onEnd((end) => {
    ends.push(end);
  });

  const execID = await connection.execID;

  await connection.write(new TextEncoder().encode('in'));

  connection.endInput();

  await waitFor(() => {
    expect(ends).toStrictEqual([{ kind: 'exit', exitCode: 7 }]);
  });

  expect([execID, stdout, stderr, [...(ctx.received[0] ?? [])]]).toStrictEqual([
    '1847',
    ['hi'],
    ['op'],
    [0, 105, 110],
  ]);
});

test('it ends the input of a command that takes none, once the socket is open', async () => {
  const ctx = setupTest();
  const ends: ExecEnd[] = [];

  const connection = openExecConnection({
    apiURL: ctx.apiURL,
    token: 'secret-token',
    sprite: 'atc-h1',
    request: { argv: ['cat'], tty: false },
  });

  connection.onEnd((end) => {
    ends.push(end);
  });

  connection.endInput();

  await waitFor(() => {
    expect(ends).toStrictEqual([{ kind: 'exit', exitCode: 7 }]);
  });

  expect(ctx.received).toStrictEqual([new Uint8Array([4])]);
});

test('it attaches by exec id in a path of its own', async () => {
  const ctx = setupTest();

  const connection = openExecConnection({
    apiURL: ctx.apiURL,
    token: 'secret-token',
    sprite: 'atc-h1',
    request: { execID: '1847', argv: [], tty: false },
  });

  const execID = await connection.execID;

  connection.detach();

  expect([execID, new URL(ctx.urls[0] ?? '').pathname]).toStrictEqual([
    '1847',
    '/v1/sprites/atc-h1/exec/1847',
  ]);
});
