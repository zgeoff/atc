import { normalizeClientName } from '../shared/normalize-client-name';
import { buildPageResponse } from './build-page-response';
import { findClientName } from './find-client-name';
import type { HTTPServerContext } from './types';

// Where an authorization request came from, as the HTTP request shows it.
interface Requester {
  readonly socketAddress: string | null;
  readonly connectingIP: string | null;
  readonly userAgent: string | null;
}

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
    return response;
  }

  const clientID = target.searchParams.get('client_id') ?? '';
  const redirectURI = target.searchParams.get('redirect_uri') ?? '';

  const storedName = await findClientName(ctx.store.db, clientID);

  const clientName = normalizeClientName(storedName);

  const approval = ctx.approvals.createPending({
    key: target.search.slice(1),
    clientID,
    clientName,
    redirectURI,
  });

  if (approval === null) {
    return buildPageResponse(429, {
      message: 'Too many approvals started in the last minute. Wait a minute, then start again.',
    });
  }

  const code = `${approval.approvalCode.slice(0, 4)}-${approval.approvalCode.slice(4)}`;

  const from =
    requester.connectingIP === null
      ? normalizeClientName(requester.socketAddress, 'an unknown address', 45)
      : `${normalizeClientName(requester.connectingIP, 'an empty address', 45)} (reported by CF-Connecting-IP)`;

  const userAgent = normalizeClientName(requester.userAgent, 'none', 60);

  ctx.printApproval(
    `Approve ${clientName} (returns to ${new URL(redirectURI).host}) with code ${code}. Requested from ${from}, user agent "${userAgent}". The code expires in 10 minutes.`,
  );

  return response;
}
