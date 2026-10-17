import { LineDecoder, PROTOCOL_V, decodeMessage, encodeMessage } from '@atc/protocol/wire';
import { registerTestCleanup } from './register-test-cleanup';

export function startStubRestoreDaemon(socketPath: string) {
  const lists: Readonly<Record<string, unknown>>[] = [];
  const methods: string[] = [];

  const unknown = new Set<string>();

  // Each connection gets a decoder of its own, so a partial line from one
  // client never joins a line from another.
  const server = Bun.listen<{ lines: LineDecoder }>({
    unix: socketPath,
    socket: {
      open(socket) {
        socket.data = { lines: new LineDecoder() };
      },
      data(socket, buf) {
        const requests = socket.data.lines
          .splitChunk(buf)
          .map((line) => decodeMessage(line))
          .filter((decoded) => decoded.kind === 'request');

        for (const request of requests) {
          methods.push(request.msg.m);

          if (unknown.has(request.msg.m)) {
            socket.write(
              encodeMessage({
                v: PROTOCOL_V,
                id: request.msg.id,
                err: { code: 'unknown_method', msg: `unknown method '${request.msg.m}'` },
              }),
            );

            continue;
          }

          const ok = request.msg.m === 'fleet.restore' ? {} : lists.shift();

          if (ok !== undefined) {
            socket.write(encodeMessage({ v: PROTOCOL_V, id: request.msg.id, ok }));
          }
        }
      },
    },
  });

  const stop = registerTestCleanup(() => {
    server.stop(true);
  });

  return {
    lists,
    methods,
    unknown,
    stop,
  };
}
