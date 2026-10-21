import { buildPageResponse } from '../http/build-page-response';
import { normalizeClientName } from './normalize-client-name';
import { readClientName } from './read-client-name';
import type { AuthorizeInvalidReason, HTTPServerContext, Requester } from './types';

export async function answerAuthorizeRequest(
  ctx: HTTPServerContext,
  url: URL,
  requester: Requester,
): Promise<Response> {
  const params = new URLSearchParams(url.searchParams);

  // every authorization asks for a fresh passkey sign-in and the consent page,
  // whatever session or consent the browser kept.
  params.set('prompt', 'login consent');

  const scope = params.get('scope');

  if (scope !== null) {
    const scopes = scope.split(' ').filter((item) => item !== '');

    params.set('scope', [...new Set([...scopes, 'offline_access'])].join(' '));
  }

  if (!params.has('resource')) {
    params.set('resource', ctx.resource);
  }

  const response = await ctx.store.auth.handler(
    new Request(`${ctx.origin}/oauth2/authorize?${params.toString()}`, {
      headers: { accept: 'text/html' },
    }),
  );

  const location = response.headers.get('location');
  const target = location === null ? null : new URL(location, ctx.origin);

  if (target === null || target.origin !== ctx.origin || target.pathname !== '/login') {
    await recordInvalidRequest(ctx, url, requester, target);

    return response;
  }

  const clientID = target.searchParams.get('client_id') ?? '';
  const redirectURI = target.searchParams.get('redirect_uri') ?? '';

  const storedName = await readClientName(ctx.store.db, clientID);

  const clientName = normalizeClientName(storedName);

  const accepted = {
    path: url.pathname,
    requester,
    client: { id: clientID, name: clientName },
    redirectHost: new URL(redirectURI).host,
  };

  const approval = ctx.approvals.createPending({
    key: target.search.slice(1),
    clientID,
    clientName,
    redirectURI,
  });

  if (approval === null) {
    ctx.security.record({
      kind: 'authorize_started',
      outcome: 'rejected',
      reason: 'rate_limited',
      ...accepted,
    });

    return buildPageResponse(429, {
      message: 'Too many approvals started in the last minute. Wait a minute, then start again.',
    });
  }

  ctx.security.record({
    kind: 'authorize_started',
    outcome: 'accepted',
    ...accepted,
    correlationID: approval.correlationID,
  });

  return response;
}

// A refusal that returns to the client went to a redirect URI better-auth
// validated, so only then does the event hold its host. The client's id
// and name go in only for a client atc holds.
async function recordInvalidRequest(
  ctx: HTTPServerContext,
  url: URL,
  requester: Requester,
  target: URL | null,
): Promise<void> {
  const code = target?.searchParams.get('error') ?? null;
  const reason = isAuthorizeError(code) ? code : 'other';
  const clientID = url.searchParams.get('client_id');
  const storedName = clientID === null ? null : await readClientName(ctx.store.db, clientID);

  ctx.security.record({
    kind: 'authorize_invalid',
    outcome: 'rejected',
    reason,
    path: url.pathname,
    requester,
    ...(clientID === null || storedName === null
      ? {}
      : { client: { id: clientID, name: normalizeClientName(storedName) } }),
    ...(target === null || target.origin === ctx.origin ? {} : { redirectHost: target.host }),
  });
}

// The better-auth error codes an `authorize_invalid` event may hold; any
// other code becomes `other`.
const AUTHORIZE_ERRORS: ReadonlySet<string> = new Set([
  'invalid_client',
  'client_disabled',
  'invalid_redirect',
  'unauthorized_client',
  'unsupported_response_type',
  'invalid_request',
  'invalid_scope',
  'invalid_target',
]);

function isAuthorizeError(code: string | null): code is AuthorizeInvalidReason {
  return code !== null && AUTHORIZE_ERRORS.has(code);
}
