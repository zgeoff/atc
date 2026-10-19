import { isRecord } from '@atc/core';
import {
  MessageType,
  deserializeRequestMessage,
  deserializeResponseMessage,
} from '@orpc/standard-server-peer';
import type { BaseMessageFormat } from '@orpc/standard-server-peer';
import type { Socket } from 'bun';
import { registerTestCleanup } from './register-test-cleanup';

interface CutProxyOptions {
  // The address the proxy forwards to.
  readonly target: { readonly hostname: string; readonly port: number };

  // The request method whose response the proxy loses, and how many times.
  readonly method: string;
  readonly cuts: number;

  // Close ends both sides where the response would pass; hold swallows it and
  // every later byte from the target, keeping the link open; drop ends both
  // sides in place of forwarding the request, so the target never sees it.
  readonly mode: 'close' | 'hold' | 'drop';
}

export interface CutProxy {
  readonly port: number;

  // How many requests of the method the proxy has seen.
  readonly countRequests: () => number;

  // How many answers the proxy has swallowed in hold mode.
  readonly countHeld: () => number;
  readonly stop: () => void;
}

// One proxied connection: what the client sent before the target side
// connected, each side's unfinished line, the message id of the request
// whose answer is lost, and whether every answer from now on is.
interface ProxyLink {
  upstream: Socket | null;
  readonly pending: Uint8Array[];
  readonly decoder: TextDecoder;
  lineBuffer: string;
  readonly upstreamDecoder: TextDecoder;
  upstreamBuffer: string;
  cutID: string | null;
  held: boolean;

  // Counts an answer the link swallows in hold mode.
  readonly onHold: () => void;
}

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
          upstreamDecoder: new TextDecoder(),
          upstreamBuffer: '',
          cutID: null,
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
          const request = findPeerRequest(line);

          if (request?.method !== options.method) {
            continue;
          }

          requests++;

          if (cutsLeft > 0) {
            cutsLeft--;
            client.data.cutID = options.mode === 'drop' ? null : request.id;
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
  };
}

// The target's lines pass whole, so the answer to the cut request is lost
// while the events the target sends before it still arrive. A target that
// cannot be reached ends the client.
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

          client.data.upstreamBuffer += client.data.upstreamDecoder.decode(buf, { stream: true });

          const lines = client.data.upstreamBuffer.split('\n');

          client.data.upstreamBuffer = lines.pop() ?? '';

          for (const line of lines) {
            if (client.data.cutID !== null && findResponseID(line) === client.data.cutID) {
              applyCut(client, options);

              return;
            }

            client.write(`${line}\n`);
          }
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

function findResponseID(line: string): string | null {
  const message = parsePeerMessage(line);

  if (message === null) {
    return null;
  }

  try {
    return deserializeResponseMessage(message)[0];
  } catch {
    return null;
  }
}

const MESSAGE_TYPES: readonly MessageType[] = [
  MessageType.REQUEST,
  MessageType.RESPONSE,
  MessageType.EVENT_ITERATOR,
  MessageType.ABORT_SIGNAL,
];

// A line in the shape of an oRPC peer message: a string id, a payload, and
// a known message type when it gives one.
function parsePeerMessage(line: string): BaseMessageFormat | null {
  let parsed: unknown;

  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }

  if (!isRecord(parsed) || typeof parsed['i'] !== 'string') {
    return null;
  }

  const given = parsed['t'];
  const type = MESSAGE_TYPES.find((known) => known === given);

  if (given !== undefined && type === undefined) {
    return null;
  }

  return { i: parsed['i'], p: parsed['p'], ...(type === undefined ? {} : { t: type }) };
}

// Hold swallows the answer and every later byte, keeping the link open;
// close ends both sides.
function applyCut(client: Socket<ProxyLink>, options: CutProxyOptions): void {
  client.data.cutID = null;

  if (options.mode === 'hold') {
    client.data.held = true;

    client.data.onHold();

    return;
  }

  client.end();
  client.data.upstream?.end();
}

// A peer request line's message id and method, the dotted path of its
// procedure; null for any other line, a request whose payload the decoder
// cannot read included, so the proxy never cuts its answer.
function findPeerRequest(line: string): { readonly id: string; readonly method: string } | null {
  const message = parsePeerMessage(line);

  if (message === null) {
    return null;
  }

  try {
    const [id, type, payload] = deserializeRequestMessage(message);

    return type === MessageType.REQUEST
      ? { id, method: payload.url.pathname.slice(1).replaceAll('/', '.') }
      : null;
  } catch {
    return null;
  }
}
