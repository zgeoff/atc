import { isRecord } from '@atc/core';
import { registerTestCleanup } from '@zgeoff/testing';
import type { Server, ServerWebSocket } from 'bun';

type StubExecReply = 'refuse' | 'count' | 'exit-early';

// Answers the sockets that @impz/testing cannot: impd's exec socket, which
// needs a VM, and its tunnel socket, whose unix-socket forwards the package's
// guest lacks. Another request goes to the upstream impd, when there is one.
export function startStubImpdSockets(options: { readonly upstreamUrl?: string } = {}) {
  const authorizations: (string | null)[] = [];
  const controls: ServerWebSocket[] = [];
  const relays: ServerWebSocket[] = [];
  const execOpens: unknown[] = [];
  const exec: { reply: StubExecReply } = { reply: 'refuse' };

  const counted = new WeakMap<ServerWebSocket, number>();

  const answerRequest = async (
    request: Request,
    bunServer: Server<undefined>,
  ): Promise<Response | undefined> => {
    const path = new URL(request.url).pathname;

    if ((path === '/tunnel' || path === '/exec') && bunServer.upgrade(request)) {
      authorizations.push(request.headers.get('authorization'));

      return undefined;
    }

    if (options.upstreamUrl === undefined) {
      return new Response('no upstream impd', { status: 404 });
    }

    const body = request.method === 'GET' ? null : await request.arrayBuffer();

    const upstream = await fetch(
      new URL(`${path}${new URL(request.url).search}`, options.upstreamUrl),
      { method: request.method, headers: request.headers, body },
    );

    const headers = new Headers(upstream.headers);

    headers.delete('content-encoding');
    headers.delete('content-length');

    const answer = await upstream.arrayBuffer();

    return new Response(answer, { status: upstream.status, headers });
  };

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: answerRequest,
    websocket: {
      // Impd refuses a message over its own limit.
      maxPayloadLength: 2 * 1024 * 1024,
      message: (socket, message) => {
        const seen = counted.get(socket);

        if (typeof message !== 'string') {
          if (seen !== undefined) {
            counted.set(socket, seen + message.byteLength - 1);
          }

          return;
        }

        const parsed: unknown = JSON.parse(message);

        if (!isRecord(parsed)) {
          return;
        }

        if (parsed['type'] === 'stdin_eof' && seen !== undefined) {
          const count = new TextEncoder().encode(`${String(seen)}\n`);

          socket.send(new Uint8Array([1, ...count]));
          socket.send(JSON.stringify({ type: 'exit', code: 0, signal: null }));

          return;
        }

        if (parsed['type'] === 'start' || parsed['type'] === 'attach') {
          execOpens.push(parsed);

          if (exec.reply === 'refuse') {
            socket.send(
              JSON.stringify({
                type: 'error',
                code: 'PRECONDITION_FAILED',
                message: 'the broker is not ready',
                data: { reason: 'broker_not_ready', detail: 'the broker CA did not install' },
              }),
            );

            return;
          }

          socket.send(JSON.stringify({ type: 'started', pid: 7 }));

          if (exec.reply === 'count') {
            counted.set(socket, 0);

            return;
          }

          socket.send(JSON.stringify({ type: 'exit', code: 2, signal: null }));

          return;
        }

        if (parsed['type'] === 'listen') {
          controls.push(socket);

          socket.send(
            JSON.stringify({ type: 'listening', listener: 'l1', path: '/tmp/r.sock', port: null }),
          );
        }

        if (parsed['type'] === 'accept') {
          relays.push(socket);
          socket.send(JSON.stringify({ type: 'opened' }));
        }
      },
    },
  });

  const stop = registerTestCleanup(() => server.stop(true));

  return {
    url: `http://127.0.0.1:${String(server.port)}`,
    authorizations,
    controls,
    relays,
    execOpens,
    exec,
    stop,
  };
}
