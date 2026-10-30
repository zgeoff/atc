import { isRecord } from '@atc/core';
import { GATEWAY_PATHS } from '@atcx/contract';
import { Elysia } from 'elysia';
import invariant from 'tiny-invariant';
import { match } from 'ts-pattern';
import { answerAuthorizeRequest } from '../auth/answer-authorize-request';
import { answerConsentRequest } from '../auth/answer-consent-request';
import { answerEnrollRequest } from '../auth/answer-enroll-request';
import { answerLoginRequest } from '../auth/answer-login-request';
import { recordRefusedExchange } from '../auth/record-refused-exchange';
import type { HTTPServerContext, Requester, SecurityEvent } from '../auth/types';
import { answerMCPRequest } from './answer-mcp-request';
import { buildPageResponse } from './build-page-response';
import { pickErrorMessage } from './pick-error-message';

interface MCPHTTPAppOptions {
  // The Host header values the server answers to.
  readonly hosts: ReadonlySet<string>;

  // The origins a browser form or an MCP request may come from.
  readonly origins: ReadonlySet<string>;

  // Serves `/healthz` and `/readyz` for an orchestrator's probes.
  readonly probes: boolean;

  // The routes' context once the authorization server's database is open,
  // and null before.
  readonly readContext: () => HTTPServerContext | null;

  // Where a request came from, for its security events.
  readonly readRequester: (request: Request) => Requester;

  // Runs on each MCP request that passed the Host and origin checks, before
  // the transport reads its body.
  readonly onMCPRequest: (request: Request) => Promise<void>;

  // Receives each refused Host or origin.
  readonly security: { readonly record: (event: SecurityEvent) => void };
}

const PROBE_PATHS: ReadonlySet<string> = new Set(Object.values(GATEWAY_PATHS.probes));

// MCP answers at `/` as well as at `/mcp`, for a client configured with the
// bare origin. Both are the one resource `<origin>/mcp`.
const MCP_PATHS = [GATEWAY_PATHS.machine.mcp, GATEWAY_PATHS.machine.root] as const;

// The browser pages: passkey sign-in, passkey enrollment, and consent.
const PAGE_PATHS = [
  GATEWAY_PATHS.browser.login,
  GATEWAY_PATHS.browser.enroll,
  GATEWAY_PATHS.browser.consent,
] as const;

// Both paths serve the protected resource metadata for `<origin>/mcp`.
const RESOURCE_METADATA_PATHS = [
  GATEWAY_PATHS.machine.resourceMetadata,
  GATEWAY_PATHS.machine.mcpResourceMetadata,
] as const;

export function createMCPHTTPApp(options: MCPHTTPAppOptions) {
  const requireContext = (): HTTPServerContext => {
    const ctx = options.readContext();

    invariant(ctx, 'a route ran before the authorization server opened');

    return ctx;
  };

  const app = new Elysia()
    .onRequest((context) => {
      const path = new URL(context.request.url).pathname;

      const host = context.request.headers.get('host');

      if (host === null || !options.hosts.has(host)) {
        options.security.record({
          kind: 'authorize_invalid',
          outcome: 'rejected',
          reason: 'bad_host',
          path,
          requester: options.readRequester(context.request),
        });

        return new Response(null, { status: 403 });
      }

      const isProbe = options.probes && PROBE_PATHS.has(path);
      const isClosed = !isProbe && options.readContext() === null;

      // Elysia answers with any value a hook returns but undefined, null included
      return isClosed ? new Response(null, { status: 503 }) : undefined;
    })
    .onError((context) =>
      context.code === 'NOT_FOUND'
        ? new Response(null, { status: 404 })
        : new Response(null, { status: 503 }),
    )
    .post(GATEWAY_PATHS.machine.revoke, (context) =>
      requireContext().store.auth.handler(toPublicRequest(requireContext(), context.request)),
    )
    .get(GATEWAY_PATHS.machine.authorizationServerMetadata, (context) =>
      answerMetadataRequest(requireContext(), context.request, 'authorization-server'),
    )
    .get(GATEWAY_PATHS.browser.authorize, (context) =>
      answerAuthorizeRequest(
        requireContext(),
        new URL(context.request.url),
        options.readRequester(context.request),
      ),
    )
    .post(GATEWAY_PATHS.machine.token, (context) =>
      answerTokenRequest(requireContext(), context.request, options.readRequester(context.request)),
    )
    .get(GATEWAY_PATHS.browser.error, (context) => {
      const error = new URL(context.request.url).searchParams.get('error');

      return buildPageResponse(400, { message: pickErrorMessage(error) });
    });

  for (const path of RESOURCE_METADATA_PATHS) {
    app.get(path, (context) =>
      answerMetadataRequest(requireContext(), context.request, 'resource'),
    );
  }

  if (options.probes) {
    for (const path of PROBE_PATHS) {
      app.all(path, (context) =>
        answerProbeRequest(
          context.request.method,
          path === GATEWAY_PATHS.probes.health || options.readContext() !== null,
        ),
      );
    }
  }

  for (const path of PAGE_PATHS) {
    app.get(path, (context) =>
      answerPageRequest(requireContext(), {
        path,
        request: context.request,
        body: '',
        requester: options.readRequester(context.request),
      }),
    );

    app.post(
      path,
      async (context) => {
        const body = await context.request.text();

        return answerPageRequest(requireContext(), {
          path,
          request: context.request,
          body,
          requester: options.readRequester(context.request),
        });
      },
      {
        // a form posts from the server's own pages, so a post with no origin
        // or another one is a forged form
        beforeHandle: (context) => {
          const origin = context.request.headers.get('origin');
          const isForged = origin === null || !options.origins.has(origin);

          if (isForged) {
            recordBadOrigin(options, context.request);
          }

          return isForged
            ? buildPageResponse(403, { message: 'The form came from an unexpected origin.' })
            : undefined;
        },
      },
    );
  }

  for (const path of MCP_PATHS) {
    app.all(
      path,
      async (context) => {
        if (context.request.method !== 'POST') {
          return new Response(null, { status: 405, headers: { allow: 'POST' } });
        }

        await options.onMCPRequest(context.request);

        return answerMCPRequest(
          requireContext(),
          context.request,
          options.readRequester(context.request),
        );
      },
      {
        beforeHandle: (context) => {
          const origin = context.request.headers.get('origin');
          const isForeign = origin !== null && !options.origins.has(origin);

          if (isForeign) {
            recordBadOrigin(options, context.request);
          }

          return isForeign ? new Response(null, { status: 403 }) : undefined;
        },
      },
    );
  }

  return app;
}

// better-auth builds every URL it returns from its base URL, so a request
// that reached the local address is handed over as if it came to the public
// origin.
function toPublicRequest(ctx: HTTPServerContext, request: Request): Request {
  const url = new URL(request.url);

  return new Request(`${ctx.origin}${url.pathname}${url.search}`, request);
}

// The metadata advertises only what atc's clients can use: public clients
// with no client authentication, no introspection endpoint, and Bearer
// tokens alone, so nothing about DPoP.
async function answerMetadataRequest(
  ctx: HTTPServerContext,
  request: Request,
  kind: 'authorization-server' | 'resource',
): Promise<Response> {
  const response = await ctx.store.auth.handler(toPublicRequest(ctx, request));
  const metadata: unknown = await response.json();

  if (!isRecord(metadata)) {
    return new Response(null, { status: 503 });
  }

  const advertised = Object.fromEntries(
    Object.entries(metadata).filter(
      ([key]) => !key.startsWith('introspection_') && !key.startsWith('dpop_'),
    ),
  );

  if (kind === 'resource') {
    return Response.json(advertised, { status: response.status });
  }

  return Response.json({
    ...advertised,
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
  });
}

// better-auth binds a code exchange's tokens to the owner session that approved it.
async function answerTokenRequest(
  ctx: HTTPServerContext,
  request: Request,
  requester: Requester,
): Promise<Response> {
  // the body is read once here, so the refusal's event can name its client.
  const body = await request.text();

  const sent = new Request(request.url, { method: request.method, headers: request.headers, body });

  const response = await ctx.store.auth.handler(toPublicRequest(ctx, sent));

  if (!response.ok) {
    await recordRefusedExchange(ctx, {
      contentType: request.headers.get('content-type'),
      body,
      response,
      path: new URL(request.url).pathname,
      requester,
    });

    return response;
  }

  const attached = await ctx.store.db
    .selectFrom('oauthAccessToken')
    .select('sessionId')
    .where('sessionId', 'is not', null)
    .union(
      ctx.store.db
        .selectFrom('oauthRefreshToken')
        .select('sessionId')
        .where('sessionId', 'is not', null),
    )
    .execute();

  const sessionIDs = attached.flatMap((row) => (row.sessionId === null ? [] : [row.sessionId]));

  // detached tokens outlive their session, so a session's end never ends a grant.
  await ctx.store.db
    .updateTable('oauthAccessToken')
    .set({ sessionId: null })
    .where('sessionId', 'is not', null)
    .execute();

  await ctx.store.db
    .updateTable('oauthRefreshToken')
    .set({ sessionId: null })
    .where('sessionId', 'is not', null)
    .execute();

  const now = new Date(ctx.clock.now()).toISOString();

  // the session's one authorization is done.
  await ctx.store.db
    .deleteFrom('session')
    .where((eb) =>
      eb.or([
        eb('expiresAt', '<', now),
        ...(sessionIDs.length === 0 ? [] : [eb('id', 'in', sessionIDs)]),
      ]),
    )
    .execute();

  return response;
}

// `ready` is whether the probe answers ready; its body stays empty, so a
// probe learns nothing about the fleet.
function answerProbeRequest(method: string, ready: boolean): Response {
  if (method !== 'GET' && method !== 'HEAD') {
    return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } });
  }

  return new Response(null, { status: ready ? 200 : 503 });
}

interface PageRequest {
  readonly path: (typeof PAGE_PATHS)[number];
  readonly request: Request;
  readonly body: string;
  readonly requester: Requester;
}

function answerPageRequest(ctx: HTTPServerContext, page: PageRequest): Promise<Response> {
  const method = page.request.method === 'POST' ? 'POST' : 'GET';

  const url = new URL(page.request.url);

  return match(page.path)
    .with(GATEWAY_PATHS.browser.login, () =>
      answerLoginRequest(ctx, { method, url, body: page.body, requester: page.requester }),
    )
    .with(GATEWAY_PATHS.browser.enroll, () =>
      answerEnrollRequest(ctx, { method, url, body: page.body, requester: page.requester }),
    )
    .with(GATEWAY_PATHS.browser.consent, () =>
      answerConsentRequest(ctx, {
        method,
        url,
        cookie: page.request.headers.get('cookie'),
        body: page.body,
        requester: page.requester,
      }),
    )
    .exhaustive();
}

function recordBadOrigin(options: MCPHTTPAppOptions, request: Request): void {
  options.security.record({
    kind: 'authorize_invalid',
    outcome: 'rejected',
    reason: 'bad_origin',
    path: new URL(request.url).pathname,
    requester: options.readRequester(request),
  });
}
