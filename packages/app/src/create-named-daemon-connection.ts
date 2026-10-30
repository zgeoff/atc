import { createHash } from 'node:crypto';
import { createChannelCaller } from '@atc/mcp';
import type { WatchChannel } from '@atc/mcp';
import type { DaemonChannel } from '@atc/protocol/wire';
import { DaemonError } from '@atc/protocol/wire';
import type { MCPDaemonConnection } from './mcp-http-server';

// A channel to the named daemon whose handshake has passed, which serves tool
// requests and live terminals alike.
export interface NamedDaemonChannel extends DaemonChannel, WatchChannel {
  principal: string | undefined;
}

interface NamedDaemon {
  readonly name: string;

  // Opens a channel as the principal of the config entry. A viewer narrows
  // the channel's events and output, at the daemon, to what the entry and
  // the viewer may both see.
  readonly openChannel: (viewer: string | null) => Promise<NamedDaemonChannel>;
}

export function createNamedDaemonConnection(daemon: NamedDaemon): MCPDaemonConnection {
  const channels = createChannelCaller(() => daemon.openChannel(null));

  return {
    caller: {
      ...channels,
      sendRequest: async (method, params, principal) => {
        const keyed =
          principal === undefined ? params : toConnectorKeyedParams(principal.id, params);

        try {
          return await channels.sendRequest(method, keyed, principal);
        } catch (error) {
          throw toConnectorRefusal(daemon.name, principal?.id ?? null, error);
        }
      },
    },
    openWatchChannel: async (principal) => {
      if (principal === null) {
        return daemon.openChannel(null);
      }

      const watched = await daemon.openChannel(principal);

      watched.principal = principal;

      return watched;
    },
  };
}

// The daemon keeps every key of a connection under the connection's
// principal, so two connectors that pick the same key would share it.
function toConnectorKeyedParams(
  connector: string,
  params: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> | undefined {
  const key = params?.['idempotencyKey'];

  if (typeof key !== 'string') {
    return params;
  }

  const hashed = createHash('sha256').update(`${connector}\u0000${key}`).digest('hex');

  return { ...params, idempotencyKey: `connector-${hashed}` };
}

// The daemon's refusal of a connector principal its own config does not list
// names no daemon, and the connector cannot tell which host refused it.
function toConnectorRefusal(daemonName: string, principal: string | null, error: unknown) {
  if (principal === null || !(error instanceof DaemonError) || error.code !== 'unauthorized') {
    return error;
  }

  return new DaemonError(
    'unauthorized',
    `daemon '${daemonName}' refused a request as the connector principal '${principal}': ${error.message}`,
  );
}
