import { randomUUID } from 'node:crypto';
import type { Principal } from '@atc/protocol';
import { PROCEDURE_TRAITS } from '@atc/protocol';
import { readSessionEnv } from '@atc/protocol/session';
import type { DaemonChannel } from '@atc/protocol/wire';
import { DaemonTransport } from '@atc/protocol/wire/transport';
import type { FleetCaller, FleetFeature } from './types';

export class TransportCaller implements FleetCaller {
  private readonly transport: DaemonTransport<DaemonChannel>;

  // each channel is handshaken before a request rides it, claiming the session the
  // caller runs inside, which takes the answer notices of the messages it sends;
  // null claims none.
  constructor(
    socketPath: string,
    build: string,
    openChannel: (socketPath: string) => Promise<DaemonChannel>,
    session: string | null = readSessionEnv(process.env).sessionID ?? null,
  ) {
    this.transport = new DaemonTransport({
      reconnect: 'on-demand',
      open: () => openHandshaken(socketPath, build, openChannel, session),
      getChannel: (client) => client,
    });
  }

  async sendRequest(
    method: string,
    requestParams?: Readonly<Record<string, unknown>>,
    principal?: Principal,
  ): Promise<Readonly<Record<string, unknown>>> {
    const opened = await this.transport.waitForConnection();

    const keyed = PROCEDURE_TRAITS.get(method)?.keyed === true;
    const params = keyed ? buildKeyedParams(requestParams) : requestParams;

    try {
      return await opened.sendRequest(method, params, principal?.id, principal?.name);
    } catch (error) {
      // only a read-only or keyed request is retried, since any other must not run twice.
      if (
        !this.transport.isLost(opened) ||
        !(keyed || PROCEDURE_TRAITS.get(method)?.readOnly === true)
      ) {
        throw error;
      }

      const fresh = await this.transport.waitForConnection();

      return fresh.sendRequest(method, params, principal?.id, principal?.name);
    }
  }

  // A single daemon routes to no named daemons, so the set is empty. The read
  // still handshakes, so a daemon that cannot be reached refuses it.
  async readFeatures(): Promise<ReadonlySet<FleetFeature>> {
    await this.transport.waitForConnection();

    return new Set();
  }

  stop(): Promise<void> {
    this.transport.stop();

    return Promise.resolve();
  }
}

// Opens a connection and handshakes it, closing one whose handshake fails.
async function openHandshaken(
  socketPath: string,
  build: string,
  openChannel: (socketPath: string) => Promise<DaemonChannel>,
  session: string | null,
): Promise<DaemonChannel> {
  const client = await openChannel(socketPath);

  const options = session === null ? {} : { session };

  try {
    await client.sendHello(build, options);
  } catch (error) {
    client.stop();
    throw error;
  }

  return client;
}

// The request's params with its idempotency key, minting one when the caller
// passed none.
function buildKeyedParams(
  params: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> {
  if (typeof params?.['idempotencyKey'] === 'string') {
    return params;
  }

  return { ...params, idempotencyKey: randomUUID() };
}
