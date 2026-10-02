import { GRANT_SCOPES } from '../shared/grant-scope';
import { buildPageResponse } from './build-page-response';
import { buildRedirectURL } from './build-redirect-url';
import { renderApprovalPage } from './render-approval-page';
import type { HTTPServerContext } from './types';

/**
 * Answers `POST /authorize`, the approval page's form. A denial redirects
 * back with `access_denied`. An approval with the right code redirects back
 * with an authorization code for the scopes the operator left checked. A
 * wrong code shows the page again, and the fifth wrong code ends the request.
 */
export function answerApprovalRequest(ctx: HTTPServerContext, body: string): Response {
  const form = new URLSearchParams(body);

  const pendingID = form.get('pending');
  const approval = typeof pendingID === 'string' ? ctx.authorization.findPending(pendingID) : null;

  if (approval === null) {
    return buildPageResponse(400, {
      message: 'This approval expired or was already used. Start again from the client.',
    });
  }

  const buildDenialResponse = () => {
    ctx.authorization.removePending(approval.id);

    return Response.redirect(
      buildRedirectURL(
        approval.redirectURI,
        { error: 'access_denied', state: approval.state },
        ctx.origin,
      ),
      302,
    );
  };

  if (form.get('decision') !== 'approve') {
    return buildDenialResponse();
  }

  const typed = form.get('code');
  const typedCode = typeof typed === 'string' ? typed : '';
  const verdict = ctx.authorization.verifyApprovalCode(approval.id, typedCode);

  if (verdict === 'locked') {
    return buildPageResponse(400, {
      message: 'Too many wrong approval codes. Start again from the client.',
    });
  }

  if (verdict === 'wrong') {
    return buildPageResponse(
      400,
      {
        page: renderApprovalPage({
          pendingID: approval.id,
          clientName: approval.client.name,
          redirectHost: new URL(approval.redirectURI).host,
          scopes: approval.scopes,
          error: 'That approval code is wrong. Check the terminal running atc mcp --http.',
        }),
      },
      [new URL(approval.redirectURI).origin],
    );
  }

  const checked = new Set(form.getAll('scope'));

  const scopes = GRANT_SCOPES.filter(
    (scope) => approval.scopes.includes(scope) && checked.has(scope),
  );

  if (scopes.length === 0) {
    return buildDenialResponse();
  }

  const code = ctx.authorization.createCode({
    clientID: approval.client.clientID,
    clientName: approval.client.name,
    redirectURI: approval.redirectURI,
    codeChallenge: approval.codeChallenge,
    scopes,
    resource: approval.resource,
  });

  return Response.redirect(
    buildRedirectURL(approval.redirectURI, { code, state: approval.state }, ctx.origin),
    302,
  );
}
