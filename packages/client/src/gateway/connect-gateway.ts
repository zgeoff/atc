import type { FleetProcedures } from '@atcx/contract';
import { CONTRACT_MAJOR, GATEWAY_MAJOR_HEADER, GATEWAY_RPC_PATH } from '@atcx/contract/light';
import { ORPCError, createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import { ClientRetryPlugin } from '@orpc/client/plugins';

export interface GatewayOptions {
  // the gateway's origin; the client calls `${url}/rpc`
  url: string;

  // a service token, a client_credentials access token, or an OAuth access token; a function is
  // called before each call and each stream reconnect, so a short-lived token can renew
  token: string | (() => string | Promise<string>);

  fetch?: typeof fetch;
}

const STREAM_PATH = 'events.stream';

// A server answer is final, except one a later try can change.
const RETRIED_CODES: ReadonlySet<string> = new Set([
  'daemon_unavailable',
  'connection_lost',
  'timeout',
]);

// The typed fleet API of an atc-gateway. Each call sends the bearer and the major version of the
// contract this client was built against, and a dropped event stream opens again after its last
// event id with a fresh token.
export function connectGateway(options: GatewayOptions): FleetProcedures {
  const send = options.fetch ?? globalThis.fetch;

  const link = new RPCLink({
    url: `${options.url.replace(/\/+$/u, '')}${GATEWAY_RPC_PATH}`,
    // oxlint-disable-next-line zgeoff/function-verb -- RPCLink names its transport option fetch
    fetch: async (request) => {
      const response = await send(request);

      if (response.status === 401) {
        throw new ORPCError('UNAUTHORIZED', {
          status: 401,
          message: 'the gateway refused the bearer token',
        });
      }

      return response;
    },
    headers: async () => {
      const token = typeof options.token === 'function' ? await options.token() : options.token;

      return { authorization: `Bearer ${token}`, [GATEWAY_MAJOR_HEADER]: String(CONTRACT_MAJOR) };
    },
    plugins: [
      new ClientRetryPlugin({
        default: {
          retry: (call) => (call.path.join('.') === STREAM_PATH ? Number.POSITIVE_INFINITY : 0),
          shouldRetry: (attempt) => {
            const error: unknown = attempt.error;

            return !(error instanceof ORPCError) || RETRIED_CODES.has(String(error.code));
          },
        },
      }),
    ],
  });

  return createORPCClient<FleetProcedures>(link);
}
