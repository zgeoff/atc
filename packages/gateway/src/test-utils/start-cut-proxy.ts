import { isRecord } from '@atc/core';
import { registerTestCleanup } from '@atc/core/test-utils/register-test-cleanup';
import {
  MessageType,
  deserializeRequestMessage,
  deserializeResponseMessage,
} from '@orpc/standard-server-peer';
import type { BaseMessageFormat } from '@orpc/standard-server-peer';
import type { Socket } from 'bun';

interface CutProxyOptions {
  readonly target: { readonly hostname: string; readonly port: number };

  readonly method: string;
  readonly cuts: number;

  readonly mode: 'close' | 'hold' | 'drop';
}

export interface CutProxy {
  readonly port: number;

  readonly countRequests: () => number;

  readonly countHeld: () => number;
  readonly stop: () => void;
}

interface ProxyLink {
  upstream: Socket | null;
  readonly pending: Uint8Array[];
  readonly decoder: TextDecoder;
  lineBuffer: string;
  readonly upstreamDecoder: TextDecoder;
  upstreamBuffer: string;
  cutID: string | null;
  held: boolean;

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

function parsePeerMessage(line: string): BaseMessageFormat | null {
  let parsed: unknown;

  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }

  return isPeerMessage(parsed) ? parsed : null;
}

const MESSAGE_TYPES: readonly MessageType[] = [
  MessageType.REQUEST,
  MessageType.RESPONSE,
  MessageType.EVENT_ITERATOR,
  MessageType.ABORT_SIGNAL,
];

function isPeerMessage(value: unknown): value is BaseMessageFormat {
  if (!isRecord(value) || typeof value['i'] !== 'string') {
    return false;
  }

  const given = value['t'];

  return given === undefined || MESSAGE_TYPES.some((known) => known === given);
}

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
