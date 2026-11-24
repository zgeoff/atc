import type { FleetContext, FleetRouter } from '@atc/fleet-api';
import { GATEWAY_MAJOR_HEADER, GATEWAY_PATHS } from '@atcx/contract';
import { CONTRACT_MAJOR } from '@atcx/contract/light';
import { ORPCError } from '@orpc/server';
import { RPCHandler } from '@orpc/server/fetch';
import type { Requester, SecuritySink } from '@zgeoff/mcp-auth';
import type { Clock } from '@zgeoff/std';
import type { VerifiedAccess } from '../auth/types';
import { buildRPCError } from './build-rpc-error';
import { buildRPCLogPath } from './build-rpc-log-path';
import { guardEventStream } from './guard-event-stream';

interface RPCRouteOptions {
  readonly router: FleetRouter;

  // Verifies a bearer as `/mcp` does.
  readonly verify: (bearer: string) => Promise<VerifiedAccess | null>;
  readonly clock: Pick<Clock, 'schedule'>;
  readonly security: SecuritySink;
  readonly hosts: ReadonlySet<string>;
  readonly origins: ReadonlySet<string>;
  readonly readRequester: (request: Request) => Requester;

  // The public origin, which the 401 challenge names the resource metadata under.
  readonly origin: string;

  readonly keepAliveMs?: number | undefined;
}

interface RPCContext extends FleetContext {
  readonly bearer: string;
  readonly isMajorMatching: boolean;
}

// The idle timeout of the HTTP server is 60 seconds.
export const RPC_KEEP_ALIVE_MS = 15_000;
export const MAX_STREAMS_PER_PRINCIPAL = 8;
const BEARER_PATTERN = /^Bearer (?<token>\S+)$/iu;

// The fleet router over HTTP: the checks `/mcp` applies before it reads a bearer, the bearer from
// the Authorization header alone, the version header, and the error answers a program may read.
export function createRPCRoute(opts: RPCRouteOptions): (request: Request) => Promise<Response> {
  const openStreams = new Map<string, number>();

  const handler = new RPCHandler<RPCContext>(opts.router, {
    eventIteratorKeepAliveInterval: opts.keepAliveMs ?? RPC_KEEP_ALIVE_MS,
    clientInterceptors: [
      async (call) => {
        if (!call.context.isMajorMatching) {
          throw new ORPCError('protocol_mismatch', {
            defined: true,
            message: `this gateway serves contract major ${CONTRACT_MAJOR}; send it as ${GATEWAY_MAJOR_HEADER}`,
            data: { gatewayMajor: CONTRACT_MAJOR },
          });
        }

        const principalID = call.context.principal?.id ?? '';
        const isStream = call.path.join('.') === 'events.stream';
        const held = openStreams.get(principalID) ?? 0;

        if (isStream && held >= MAX_STREAMS_PER_PRINCIPAL) {
          throw new ORPCError('too_many_streams', {
            defined: true,
            message: `this token holds ${MAX_STREAMS_PER_PRINCIPAL} open event streams already`,
          });
        }

        if (isStream) {
          openStreams.set(principalID, held + 1);
        }

        const release = (): void => {
          openStreams.set(principalID, Math.max((openStreams.get(principalID) ?? 1) - 1, 0));
        };

        let answer: unknown;

        try {
          answer = await call.next();
        } catch (error) {
          if (isStream) {
            release();
          }

          throw buildRPCError(error);
        }

        if (!isStream || !isAsyncIterator(answer)) {
          return answer;
        }

        return guardEventStream(answer, {
          clock: opts.clock,
          verify: opts.verify,
          bearer: call.context.bearer,
          principalID,
          signal: call.signal,
          release,
        });
      },
    ],
  });

  return async (request) => {
    const refused = refuseRequest(opts, request);

    if (refused !== null) {
      return refused;
    }

    const authorization = request.headers.get('authorization');
    const token = BEARER_PATTERN.exec(authorization ?? '')?.groups?.['token'] ?? null;

    if (token === null) {
      const reason = authorization === null ? 'missing' : 'malformed';

      recordBearerRefusal(opts, request, reason);

      return buildChallenge(`Bearer resource_metadata="${buildMetadataURL(opts)}"`);
    }

    const access = await opts.verify(token);

    if (access === null) {
      recordBearerRefusal(opts, request, 'invalid_token');

      return buildChallenge(
        `Bearer error="invalid_token", resource_metadata="${buildMetadataURL(opts)}"`,
      );
    }

    const major = request.headers.get(GATEWAY_MAJOR_HEADER);

    const result = await handler.handle(request, {
      prefix: GATEWAY_PATHS.machine.rpc,
      context: {
        principal: { id: access.clientID, name: access.clientName },
        scopes: access.scopes,
        bearer: token,
        isMajorMatching: major !== null && /^\d+$/u.test(major) && Number(major) === CONTRACT_MAJOR,
      },
    });

    return result.matched ? result.response : new Response(null, { status: 404 });
  };
}

function isAsyncIterator(value: unknown): value is AsyncIterator<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'next') === 'function' &&
    typeof Reflect.get(value, Symbol.asyncIterator) === 'function'
  );
}

function refuseRequest(opts: RPCRouteOptions, request: Request): Response | null {
  const host = request.headers.get('host');

  if (host === null || !opts.hosts.has(host)) {
    recordRefusal(opts, request, 'bad_host', 'host_not_allowed');

    return new Response(null, { status: 403 });
  }

  const origin = request.headers.get('origin');

  if (request.method === 'POST' && origin !== null && !opts.origins.has(origin)) {
    recordRefusal(opts, request, 'bad_origin', 'origin_not_allowed');

    return new Response(null, { status: 403 });
  }

  return null;
}

function recordRefusal(
  opts: RPCRouteOptions,
  request: Request,
  kind: 'bad_host' | 'bad_origin',
  reason: string,
): void {
  opts.security.record({
    kind,
    outcome: 'rejected',
    reason,
    path: buildRPCLogPath(new URL(request.url).pathname),
    requester: opts.readRequester(request),
  });
}

function recordBearerRefusal(opts: RPCRouteOptions, request: Request, reason: string): void {
  opts.security.record({
    kind: 'bearer',
    outcome: 'rejected',
    reason,
    path: buildRPCLogPath(new URL(request.url).pathname),
    requester: opts.readRequester(request),
  });
}

function buildChallenge(challenge: string): Response {
  return new Response(null, { status: 401, headers: { 'www-authenticate': challenge } });
}

function buildMetadataURL(opts: RPCRouteOptions): string {
  return `${opts.origin}${GATEWAY_PATHS.machine.mcpResourceMetadata}`;
}
