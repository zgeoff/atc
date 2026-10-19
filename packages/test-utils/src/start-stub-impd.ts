import { isRecord } from '@atc/core';
import type { Server, ServerWebSocket } from 'bun';
import { registerTestCleanup } from './register-test-cleanup';

// What the stand-in does with an exec open: refuse it as a start whose
// broker is not ready, start it and count its stdin bytes as `wc -c` does,
// or start it and exit 2 at once without reading stdin.
type StubExecReply = 'refuse' | 'count' | 'exit-early';

// The system info of impd 2.2.0, which reports every capability flag.
const SYSTEM_INFO = {
  version: '2.2.0',
  features: {
    sessionOffsets: true,
    leases: true,
    grantableTokens: true,
    secretRebind: true,
    execRequire: true,
    oauthSecrets: true,
    readOnlyFiles: true,
    execDropSysAdmin: true,
  },
};

export function startStubImpd() {
  const authorizations: (string | null)[] = [];
  const calls: { path: string; input: unknown }[] = [];

  const answers = new Map<string, { status: number; json: unknown }>();

  const controls: ServerWebSocket[] = [];
  const relays: ServerWebSocket[] = [];
  const execOpens: unknown[] = [];
  const exec: { reply: StubExecReply } = { reply: 'refuse' };

  const counted = new WeakMap<ServerWebSocket, number>();

  const answerRequest = async (request: Request, bunServer: Server<undefined>) => {
    authorizations.push(request.headers.get('authorization'));

    const path = new URL(request.url).pathname;

    const isUpgraded = (path === '/tunnel' || path === '/exec') && bunServer.upgrade(request);
    const text = isUpgraded ? '' : await request.text();
    const body: unknown = text === '' ? null : JSON.parse(text);

    if (!isUpgraded) {
      calls.push({ path, input: isRecord(body) ? body['json'] : undefined });
    }

    const answer = answers.get(path) ?? { status: 200, json: SYSTEM_INFO };

    return isUpgraded ? undefined : Response.json({ json: answer.json }, { status: answer.status });
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
    calls,
    answers,
    controls,
    relays,
    execOpens,
    exec,
    stop,
  };
}
