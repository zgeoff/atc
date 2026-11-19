import { randomUUID } from 'node:crypto';
import { PROCEDURE_TRAITS } from '@atc/protocol';
import type { DaemonChannel } from '@atc/protocol/wire';
import { createDaemonTransport } from '@atc/protocol/wire/transport';
import type { FleetCaller, FleetFeature } from './types';

export interface ChannelCaller extends FleetCaller {
  readonly stop: () => Promise<void>;
}

export function createChannelCaller(openHandshaken: () => Promise<DaemonChannel>): ChannelCaller {
  const transport = createDaemonTransport({
    reconnect: 'on-demand',
    open: openHandshaken,
    getChannel: (client) => client,
  });

  return {
    sendRequest: async (method, requestParams, principal) => {
      const opened = await transport.waitForConnection();

      const keyed = PROCEDURE_TRAITS.get(method)?.keyed === true;
      const params = keyed ? buildKeyedParams(requestParams) : requestParams;

      try {
        return await opened.sendRequest(method, params, principal?.id, principal?.name);
      } catch (error) {
        // The daemon may have run the request before the connection dropped, so resending is safe
        // only for read-only or keyed requests.
        if (
          !transport.isLost(opened) ||
          !(keyed || PROCEDURE_TRAITS.get(method)?.readOnly === true)
        ) {
          throw error;
        }

        const fresh = await transport.waitForConnection();

        return fresh.sendRequest(method, params, principal?.id, principal?.name);
      }
    },

    // A single daemon routes to no named daemons.
    features: new Set<FleetFeature>(),

    waitForDaemon: async () => {
      await transport.waitForConnection();
    },

    stop: () => {
      transport.stop();

      return Promise.resolve();
    },
  };
}

function buildKeyedParams(
  params: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> {
  if (typeof params?.['idempotencyKey'] === 'string') {
    return params;
  }

  return { ...params, idempotencyKey: randomUUID() };
}
