import { isRecord } from '../shared/report';
import { registerTestCleanup } from './register-test-cleanup';

type BridgeRequest = Readonly<Record<string, unknown>>;

/**
 * The lines the bridge writes back for one request, in order, or `null` to
 * end the connection without answering.
 */
type BridgeResponder = (request: BridgeRequest) => readonly BridgeRequest[] | null;

interface StubSessionBridge {
  // Every request line received so far, parsed, in arrival order.
  readonly requests: readonly BridgeRequest[];

  // How many reads the stand-in has taken from its connections, so a test
  // can wait until one piece of a split write has arrived.
  readonly reads: number;
  readonly stop: () => void;
}

/**
 * A stand-in for the session bridge a remote host's commands dial: listens
 * on the unix socket path and reads newline-delimited JSON requests,
 * buffering a partial line per connection. It opens every tap, answering a
 * `tap.open` request with `ok` under the request's id as the real bridge
 * does once it attaches the tap, and hands every other request to the
 * responder, writing back each line it returns. A line that is not a JSON
 * object reaches the responder as an empty request. The listener stops once
 * the current test finishes, so it must run inside a test; `stop` stops it
 * sooner, and a second stop does nothing.
 */
export function startStubSessionBridge(path: string, respond: BridgeResponder): StubSessionBridge {
  const requests: BridgeRequest[] = [];
  let reads = 0;

  const server = Bun.listen<{ pending: string }>({
    unix: path,
    socket: {
      open(socket) {
        socket.data = { pending: '' };
      },
      data(socket, chunk) {
        reads += 1;

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

  const stop = registerTestCleanup(() => {
    server.stop(true);
  });

  return {
    requests,
    get reads() {
      return reads;
    },
    stop,
  };
}

function parseRequest(line: string): BridgeRequest {
  try {
    const parsed: unknown = JSON.parse(line);

    return isRecord(parsed) && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
