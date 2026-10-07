import { LineDecoder } from '../protocol/line-decoder';
import { PROTOCOL_V, decodeMessage, encodeMessage } from '../protocol/protocol';

/**
 * A daemon stand-in on a unix socket path that speaks the real wire format
 * to a fleet restore check: it answers every `fleet.restore` with an empty
 * result, answers each other request with the next reply the test pushes
 * onto `lists`, and withholds the answer to any request that finds `lists`
 * empty. `methods` holds the method of each request it took, in order.
 * Disposal stops the listener; hold the result with `using` or
 * `await using`.
 */
export function startStubRestoreDaemon(socketPath: string) {
  const lists: Readonly<Record<string, unknown>>[] = [];
  const methods: string[] = [];

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

          const ok = request.msg.m === 'fleet.restore' ? {} : lists.shift();

          if (ok !== undefined) {
            socket.write(encodeMessage({ v: PROTOCOL_V, id: request.msg.id, ok }));
          }
        }
      },
    },
  });

  const stop = () => {
    server.stop(true);
  };

  return {
    lists,
    methods,
    [Symbol.dispose]: stop,
    [Symbol.asyncDispose]: () => {
      stop();

      return Promise.resolve();
    },
  };
}
