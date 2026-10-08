import type { Socket } from 'bun';
import { registerTestCleanup } from './register-test-cleanup';

interface CutProxyOptions {
  // The address the proxy forwards to.
  readonly target: { readonly hostname: string; readonly port: number };

  // The request method whose response the proxy loses, and how many times.
  readonly method: string;
  readonly cuts: number;

  // `close` ends both sides where the response would pass; `hold`
  // swallows it and every later byte from the target, leaving the
  // connection open; `drop` ends both sides in place of forwarding the
  // request, so the target never sees it.
  readonly mode: 'close' | 'hold' | 'drop';
}

export interface CutProxy {
  readonly port: number;

  // How many requests of the method the proxy has seen.
  readonly countRequests: () => number;

  // How many answers the proxy has swallowed in hold mode.
  readonly countHeld: () => number;
  readonly stop: () => void;
  readonly [Symbol.dispose]: () => void;
}

// One proxied connection: the target side once it is connected, what the
// client sent before it was, the client's unfinished line, and whether
// the target's next answer is lost or every answer from now on is.
interface ProxyLink {
  upstream: Socket | null;
  readonly pending: Uint8Array[];
  readonly decoder: TextDecoder;
  lineBuffer: string;
  cutting: boolean;
  held: boolean;

  // Counts an answer the link swallows in hold mode.
  readonly onHold: () => void;
}

/**
 * A TCP proxy on a loopback port that forwards an NDJSON protocol
 * connection byte for byte, except that for the first `cuts` requests of
 * the method it loses the target's next answer after the request reached
 * the target: the request runs, and the client never sees its response.
 * It stops, ending every link, once the current test finishes, so it must
 * run inside a test; `stop` or disposal stops it sooner, and a second stop
 * does nothing.
 */
export function startCutProxy(options: CutProxyOptions): CutProxy {
  let cutsLeft = options.cuts;
  let requests = 0;
  let held = 0;

  const links = new Set<Socket<ProxyLink>>();

  const server = Bun.listen<ProxyLink>({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open(client) {
        client.data = {
          upstream: null,
          pending: [],
          decoder: new TextDecoder(),
          lineBuffer: '',
          cutting: false,
          held: false,
          onHold: () => {
            held++;
          },
        };

        links.add(client);
        void openUpstream(client, options);
      },
      data(client, buf) {
        client.data.lineBuffer += client.data.decoder.decode(buf, { stream: true });

        const lines = client.data.lineBuffer.split('\n');

        client.data.lineBuffer = lines.pop() ?? '';

        let dropped = false;

        for (const line of lines) {
          if (!line.includes(`"m":"${options.method}"`)) {
            continue;
          }

          requests++;

          if (cutsLeft > 0) {
            cutsLeft--;
            client.data.cutting = options.mode !== 'drop';
            dropped = options.mode === 'drop';
          }
        }

        // A dropped request ends the link with nothing of its chunk
        // forwarded.
        if (dropped) {
          client.end();
          client.data.upstream?.end();

          return;
        }

        if (client.data.upstream === null) {
          client.data.pending.push(new Uint8Array(buf));
        } else {
          client.data.upstream.write(buf);
        }
      },
      close(client) {
        links.delete(client);
        client.data.upstream?.end();
      },
      error() {},
    },
  });

  const stop = registerTestCleanup(() => {
    for (const client of links) {
      client.end();
      client.data.upstream?.end();
    }

    server.stop(true);
  });

  return {
    port: server.port,
    countRequests: () => requests,
    countHeld: () => held,
    stop,
    [Symbol.dispose]: stop,
  };
}

// Connects the client's link to the target, forwarding what the client
// sent meanwhile, and ends the client when the target cannot be reached.
// oxlint-disable-next-line prefer-readonly-parameter-types -- a socket is a live handle the proxy writes to
async function openUpstream(client: Socket<ProxyLink>, options: CutProxyOptions): Promise<void> {
  try {
    const upstream = await Bun.connect({
      hostname: options.target.hostname,
      port: options.target.port,
      socket: {
        data(_upstream, buf) {
          if (client.data.held) {
            return;
          }

          if (!client.data.cutting) {
            client.write(buf);

            return;
          }

          client.data.cutting = false;

          if (options.mode === 'hold') {
            client.data.held = true;

            client.data.onHold();

            return;
          }

          client.end();
          client.data.upstream?.end();
        },
        close() {
          if (!client.data.held) {
            client.end();
          }
        },
        error() {},
      },
    });

    client.data.upstream = upstream;

    for (const chunk of client.data.pending.splice(0)) {
      upstream.write(chunk);
    }
  } catch {
    client.end();
  }
}
