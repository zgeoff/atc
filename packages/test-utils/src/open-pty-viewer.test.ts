import { expect, test } from 'bun:test';
import type { Server } from 'bun';
import { openPTYViewer } from './open-pty-viewer';
import { registerTestCleanup } from './register-test-cleanup';
import { waitFor } from './wait-for';

function setupTest() {
  const offered: { protocol: string | null; origin: string | null }[] = [];

  const answerUpgrade = (request: Request, served: Server<undefined>) => {
    offered.push({
      protocol: request.headers.get('sec-websocket-protocol'),
      origin: request.headers.get('origin'),
    });

    return served.upgrade(request, { headers: { 'sec-websocket-protocol': 'atc.pty.v1' } })
      ? undefined
      : new Response(null, { status: 400 });
  };

  const server = Bun.serve({
    port: 0,
    fetch: answerUpgrade,
    websocket: {
      message: () => {},
      open: (socket) => {
        socket.send(JSON.stringify({ type: 'snapshot', seq: 0, data: 'ready' }));
        socket.send(new TextEncoder().encode('first'));
        socket.send(JSON.stringify({ type: 'snapshot', seq: 1, data: 'again' }));
        socket.send(new TextEncoder().encode('second'));
      },
    },
  });

  registerTestCleanup(() => server.stop(true));

  return { url: `ws://127.0.0.1:${server.port}/sessions/s-1/pty`, offered };
}

test('it offers the protocol and the encoded token, and collects every frame in order', async () => {
  const ctx = setupTest();

  const viewer = await openPTYViewer(ctx.url, {
    token: 'token+/=',
    origin: 'https://panel.example.com',
  });

  await waitFor(() => {
    expect(viewer.frames).toHaveLength(4);
  });

  expect(ctx.offered).toStrictEqual([
    { protocol: 'atc.pty.v1, atc.bearer.dG9rZW4rLz0', origin: 'https://panel.example.com' },
  ]);

  expect(viewer.frames).toStrictEqual([
    { kind: 'control', frame: { type: 'snapshot', seq: 0, data: 'ready' } },
    { kind: 'output', data: 'first' },
    { kind: 'control', frame: { type: 'snapshot', seq: 1, data: 'again' } },
    { kind: 'output', data: 'second' },
  ]);
});

test('it reads the last snapshot followed by the output after it', async () => {
  const ctx = setupTest();

  const viewer = await openPTYViewer(ctx.url, { token: 'token' });

  await waitFor(() => {
    expect(viewer.frames).toHaveLength(4);
  });

  expect(viewer.readScreen()).toBe('againsecond');
});

test('it rejects when the server refuses the upgrade', () => {
  const server = Bun.serve({ port: 0, routes: { '/*': new Response(null, { status: 401 }) } });

  registerTestCleanup(() => server.stop(true));

  expect(openPTYViewer(`ws://127.0.0.1:${server.port}/`, { token: 'token' })).rejects.toThrow(
    'the socket closed before it opened',
  );
});
