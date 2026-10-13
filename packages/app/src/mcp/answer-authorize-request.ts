import { normalizeClientName } from '../shared/normalize-client-name';
import { APPROVAL_WINDOW_SECONDS } from './approval-window-seconds';
import { buildPageResponse } from './build-page-response';
import { findClientName } from './find-client-name';
import type { AuthorizeInvalidReason, HTTPServerContext, Requester } from './types';

/**
 * Answers `GET /oauth2/authorize`. Before better-auth validates the request,
 * atc sets three parameters of its own:
 *
 * - `prompt=login consent`, so every authorization asks for a fresh approval
 *   code and shows the consent page, whatever session or consent a browser
 *   kept from before.
 * - `offline_access` in a requested scope, so every grant gets a refresh token.
 * - `resource=<origin>/mcp` when the client gave none, so every token is bound
 *   to the one resource atc serves.
 *
 * A request better-auth sends on to the login page gets a pending approval,
 * and its code prints in atc's terminal with the client's name, the host it
 * returns to, and who asked: the `CF-Connecting-IP` address when the request
 * carries one, labelled as reported since anyone can send that header, else
 * the socket's peer address, plus the start of the user agent.
 *
 * Each request writes one security event: `authorize_started` with a fresh
 * correlation id when the approval starts, or refused by the limit on
 * starts, and `authorize_invalid` with better-auth's error code when
 * better-auth refuses the request. The event reads only the `error`
 * parameter of better-auth's redirect, never the rest of its query.
 */
export async function answerAuthorizeRequest(
  ctx: HTTPServerContext,
  url: URL,
  requester: Requester,
): Promise<Response> {
  const params = new URLSearchParams(url.searchParams);

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

  const storedName = await findClientName(ctx.store.db, clientID);

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

  const code = `${approval.approvalCode.slice(0, 4)}-${approval.approvalCode.slice(4)}`;

  const from =
    requester.connectingIP === null
      ? normalizeClientName(requester.socketAddress, 'an unknown address', 45)
      : `${normalizeClientName(requester.connectingIP, 'an empty address', 45)} (reported by CF-Connecting-IP)`;

  const userAgent = normalizeClientName(requester.userAgent, 'none', 60);

  ctx.printApproval(
    `Approve ${clientName} (returns to ${new URL(redirectURI).host}) with code ${code}. Requested from ${from}, user agent "${userAgent}". The code expires in ${String(APPROVAL_WINDOW_SECONDS / 60)} minutes.`,
  );

  return response;
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
  const storedName = clientID === null ? null : await findClientName(ctx.store.db, clientID);

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

function isAuthorizeError(code: string | null): code is AuthorizeInvalidReason {
  return code !== null && AUTHORIZE_ERRORS.has(code);
}
