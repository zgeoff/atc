import { randomUUID } from 'node:crypto';
import type { DaemonFeature, Principal } from '@atc/protocol';
import { KEYED_METHOD_FEATURES, PROCEDURE_TRAITS, parseDaemonFeatures } from '@atc/protocol';
import { readSessionEnv } from '@atc/protocol/session';
import type { DaemonChannel } from '@atc/protocol/wire';
import { DaemonTransport } from '@atc/protocol/wire/transport';
import { requireDaemonFeatures } from './require-daemon-features';
import type { FleetCaller } from './types';

// One handshaken connection and the features its daemon announced.
interface DaemonConnection {
  readonly client: DaemonChannel;
  readonly features: ReadonlySet<DaemonFeature>;
}

export class TransportCaller implements FleetCaller {
  private readonly transport: DaemonTransport<DaemonConnection>;

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
      getChannel: (connection) => connection.client,
    });
  }

  // The required features are checked against each connection right before
  // the request goes out on it, the retry's fresh connection included, since
  // a restart can put an older daemon behind the same socket.
  async sendRequest(
    m: string,
    p?: Readonly<Record<string, unknown>>,
    required: readonly DaemonFeature[] = [],
    principal?: Principal,
  ): Promise<Readonly<Record<string, unknown>>> {
    const opened = await this.transport.waitForConnection();

    requireDaemonFeatures(opened.features, required);

    const keyFeature = KEYED_METHOD_FEATURES.get(m);
    const keyed = keyFeature !== undefined && opened.features.has(keyFeature);
    const params = keyed ? buildKeyedParams(p) : p;

    try {
      return await opened.client.sendRequest(m, params, principal?.id, principal?.name);
    } catch (error) {
      // only a read-only or keyed request is retried, since any other must not run twice.
      if (
        !this.transport.isLost(opened) ||
        !(keyed || PROCEDURE_TRAITS.get(m)?.readOnly === true)
      ) {
        throw error;
      }

      const fresh = await this.transport.waitForConnection();

      // The fresh daemon has to take the key too, or the retry could run the
      // effect a second time.
      const retryRequired = keyed ? [...required, keyFeature] : required;

      requireDaemonFeatures(fresh.features, retryRequired);

      return fresh.client.sendRequest(m, params, principal?.id, principal?.name);
    }
  }

  // The features of the daemon the next request reaches, read from the
  // handshake of the connection it rides.
  async readFeatures(): Promise<ReadonlySet<DaemonFeature>> {
    const opened = await this.transport.waitForConnection();

    return opened.features;
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
): Promise<DaemonConnection> {
  const client = await openChannel(socketPath);

  const options = session === null ? {} : { session };
  let hello: Readonly<Record<string, unknown>>;

  try {
    hello = await client.sendHello(build, options);
  } catch (error) {
    client.stop();
    throw error;
  }

  return { client, features: parseDaemonFeatures(hello) };
}

// The request's params with its idempotency key, minting one when the caller
// passed none.
function buildKeyedParams(
  p: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> {
  if (typeof p?.['idempotencyKey'] === 'string') {
    return p;
  }

  return { ...p, idempotencyKey: randomUUID() };
}
