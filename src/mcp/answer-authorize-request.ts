import { buildPageResponse } from './build-page-response';
import { buildRedirectURL } from './build-redirect-url';
import { hasRedirectURI } from './has-redirect-uri';
import { parseScopeParam } from './parse-scope-param';
import { renderApprovalPage } from './render-approval-page';
import type { HTTPServerContext } from './types';

/**
 * Answers `GET /authorize`. A request that names an unknown client or a
 * redirect URI the client never registered gets an error page and is never
 * redirected. Any other invalid request is redirected back with an OAuth
 * error. A valid one starts a pending approval, prints its approval code in
 * the server's terminal, and shows the approval page.
 */
export async function answerAuthorizeRequest(
  ctx: HTTPServerContext,
  requestURL: string,
): Promise<Response> {
  const params = new URL(requestURL).searchParams;

  const clientID = params.get('client_id');

  if (clientID === null || clientID === '') {
    return buildPageResponse(400, { message: 'The authorization request has no client_id.' });
  }

  const client = await ctx.clients.resolveClient(clientID);

  if (client === null) {
    return buildPageResponse(400, { message: 'atc does not recognize this client.' });
  }

  const requestedURI = params.get('redirect_uri');

  const redirectURI =
    requestedURI ?? (client.redirectURIs.length === 1 ? client.redirectURIs[0] : undefined);

  if (redirectURI === undefined || !hasRedirectURI(client.redirectURIs, redirectURI)) {
    return buildPageResponse(400, {
      message: 'The redirect URI is not one this client registered.',
    });
  }

  const state = params.get('state');

  const buildErrorRedirect = (error: string, description: string) =>
    Response.redirect(
      buildRedirectURL(redirectURI, { error, error_description: description, state }, ctx.origin),
      302,
    );

  if (params.get('response_type') !== 'code') {
    return buildErrorRedirect('unsupported_response_type', 'atc only issues authorization codes');
  }

  const codeChallenge = params.get('code_challenge');

  if (
    codeChallenge === null ||
    codeChallenge === '' ||
    params.get('code_challenge_method') !== 'S256'
  ) {
    return buildErrorRedirect(
      'invalid_request',
      'atc requires a PKCE code_challenge with method S256',
    );
  }

  const scopes = parseScopeParam(params.get('scope'));

  if (scopes === null) {
    return buildErrorRedirect('invalid_scope', 'atc scopes are read, message, spawn, and kill');
  }

  const resource = params.get('resource');

  if (resource !== null && resource !== ctx.resource) {
    return buildErrorRedirect('invalid_target', `atc serves one resource: ${ctx.resource}`);
  }

  const approval = ctx.authorization.createPending({
    client,
    redirectURI,
    state,
    codeChallenge,
    scopes,
    resource: ctx.resource,
  });

  if (approval === null) {
    return buildErrorRedirect(
      'temporarily_unavailable',
      'too many approvals started in the last minute; try again shortly',
    );
  }

  const redirectHost = new URL(redirectURI).host;

  const identity = client.verified
    ? `verified by ${new URL(client.clientID).host}`
    : 'unverified, registered itself';

  const code = approval.approvalCode;

  ctx.printApproval(
    `Approve ${client.name} (${identity}; returns to ${redirectHost}) with code ${code.slice(0, 4)}-${code.slice(4)}. The code expires in 10 minutes.`,
  );

  return buildPageResponse(
    200,
    {
      page: renderApprovalPage({
        pendingID: approval.id,
        client,
        redirectURI,
        scopes,
        error: null,
      }),
    },
    [new URL(redirectURI).origin],
  );
}
