import { isRecord } from '@atc/core';
import { registerTestCleanup } from './register-test-cleanup';

type BridgeRequest = Readonly<Record<string, unknown>>;

type BridgeResponder = (request: BridgeRequest) => readonly BridgeRequest[] | null;

interface StubSessionBridge {
  // Every request line received so far, parsed, in arrival order.
  readonly requests: readonly BridgeRequest[];

  // How many reads the stand-in has taken from its connections, so a test
  // can wait until one piece of a split write has arrived.
  readonly reads: number;
  readonly stop: () => void;
}

interface StubSessionBridgeOptions {
  readonly unansweredOpens?: number;
}

export function startStubSessionBridge(
  path: string,
  respond: BridgeResponder,
  options: StubSessionBridgeOptions = {},
): StubSessionBridge {
  const requests: BridgeRequest[] = [];
  let reads = 0;
  let unansweredOpens = options.unansweredOpens ?? 0;

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

          if (request['op'] === 'tap.open' && unansweredOpens > 0) {
            unansweredOpens -= 1;
            continue;
          }

          // The real bridge answers tap.open with ok once it attaches the tap.
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
