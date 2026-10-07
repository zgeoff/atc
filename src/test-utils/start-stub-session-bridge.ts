import { isRecord } from '../shared/report';

type BridgeRequest = Readonly<Record<string, unknown>>;

/**
 * The lines the bridge writes back for one request, in order, or `null` to
 * end the connection without answering.
 */
type BridgeResponder = (request: BridgeRequest) => readonly BridgeRequest[] | null;

interface StubSessionBridge {
  // Every request line received so far, parsed, in arrival order.
  readonly requests: readonly BridgeRequest[];
  readonly [Symbol.dispose]: () => void;
  readonly [Symbol.asyncDispose]: () => Promise<void>;
}

/**
 * A stand-in for the session bridge a remote host's commands dial: listens
 * on the unix socket path and reads newline-delimited JSON requests,
 * buffering a partial line per connection. It opens every tap, answering a
 * `tap.open` request with `ok` under the request's id as the real bridge
 * does once it attaches the tap, and hands every other request to the
 * responder, writing back each line it returns. A line that is not a JSON
 * object reaches the responder as an empty request. Disposal stops the
 * listener; hold the result with `using` or `await using`.
 */
export function startStubSessionBridge(path: string, respond: BridgeResponder): StubSessionBridge {
  const requests: BridgeRequest[] = [];

  const server = Bun.listen<{ pending: string }>({
    unix: path,
    socket: {
      open(socket) {
        socket.data = { pending: '' };
      },
      data(socket, chunk) {
        const lines = `${socket.data.pending}${chunk.toString()}`.split('\n');

        socket.data.pending = lines.pop() ?? '';

        for (const line of lines.filter((text) => text !== '')) {
          const request = parseRequest(line);

          requests.push(request);

          const answers =
            request['op'] === 'tap.open' ? [{ id: request['id'], ok: true }] : respond(request);

          if (answers === null) {
            socket.end();

            return;
          }

          for (const answer of answers) {
            socket.write(`${JSON.stringify(answer)}\n`);
          }
        }
      },
      error() {},
    },
  });

  const stop = () => {
    server.stop(true);
  };

  return {
    requests,
    [Symbol.dispose]: stop,
    [Symbol.asyncDispose]: () => {
      stop();

      return Promise.resolve();
    },
  };
}

function parseRequest(line: string): BridgeRequest {
  try {
    const parsed: unknown = JSON.parse(line);

    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
