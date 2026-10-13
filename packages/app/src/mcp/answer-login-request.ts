import { isRecord } from '@atc/core/is-record';
import { buildConsentBinding } from './build-consent-binding';
import { buildPageResponse } from './build-page-response';
import { findOwnerSessionID } from './find-owner-session-id';
import { renderLoginPage } from './render-login-page';
import type { HTTPServerContext, Requester } from './types';

/**
 * Answers `GET /login` and `POST /login`, the approval code page better-auth
 * sends a browser to. The page exists only for an authorization request that
 * holds a pending approval. The right code signs the operator in, binds the
 * new owner session to this one request, and better-auth carries the request
 * on to the consent page. A wrong code shows the page again, and the fifth
 * wrong code ends the request.
 *
 * Each posted code writes one `owner_auth` security event: `succeeded` once
 * the owner session exists, or `failed` with why, carrying the request's
 * correlation id when the approval still waits. A code posted for an
 * approval that expired or was used fails as `expired`.
 */
export async function answerLoginRequest(
  ctx: HTTPServerContext,
  method: 'GET' | 'POST',
  url: URL,
  body: string,
  requester: Requester,
): Promise<Response> {
  const form = new URLSearchParams(body);

  const oauthQuery = method === 'GET' ? url.search.slice(1) : (form.get('oauth_query') ?? '');
  const approval = ctx.approvals.findPending(oauthQuery);

  if (approval === null) {
    if (method === 'POST') {
      ctx.security.record({
        kind: 'owner_auth',
        outcome: 'failed',
        reason: 'expired',
        path: url.pathname,
        requester,
      });
    }

    return buildPageResponse(400, {
      message: 'This approval expired or was already used. Start again from the client.',
    });
  }

  const view = {
    oauthQuery,
    clientName: approval.clientName,
    redirectURI: approval.redirectURI,
  };

  if (method === 'GET') {
    return buildPageResponse(200, { page: renderLoginPage({ ...view, error: null }) });
  }

  // Read before the code is checked, since a right code or the last wrong
  // one ends the approval.
  const context = {
    path: url.pathname,
    requester,
    client: { id: approval.clientID, name: approval.clientName },
    correlationID: approval.correlationID,
  };

  const verdict = ctx.approvals.verifyApprovalCode(oauthQuery, form.get('code') ?? '');

  if (verdict === 'locked') {
    ctx.security.record({ kind: 'owner_auth', outcome: 'failed', reason: 'locked', ...context });

    return buildPageResponse(400, {
      message: 'Too many wrong approval codes. Start again from the client.',
    });
  }

  if (verdict === 'wrong') {
    ctx.security.record({
      kind: 'owner_auth',
      outcome: 'failed',
      reason: 'wrong_code',
      ...context,
    });

    return buildPageResponse(400, {
      page: renderLoginPage({
        ...view,
        error: 'That approval code is wrong. Check the terminal running atc mcp --http.',
      }),
    });
  }

  // Resuming the authorization reads the request better-auth was called with.
  const apiHeaders = new Headers({
    accept: 'application/json',
    'content-type': 'application/json',
  });

  const signedIn = await ctx.store.auth.api.signInOwner({
    body: { oauth_query: oauthQuery },
    headers: apiHeaders,
    request: new Request(`${ctx.origin}/atc/sign-in-owner`, {
      method: 'POST',
      headers: apiHeaders,
    }),
    asResponse: true,
  });

  const resumed: unknown = await signedIn.json();

  const next = isRecord(resumed) ? resumed['url'] : undefined;

  if (!signedIn.ok || typeof next !== 'string') {
    ctx.security.record({ kind: 'owner_auth', outcome: 'failed', ...context });

    return buildPageResponse(400, {
      message: 'atc could not continue this approval. Start again from the client.',
    });
  }

  const setCookies = signedIn.headers.getSetCookie();

  const sessionID = await findOwnerSessionID(
    ctx,
    setCookies.map((line) => line.split(';')[0]).join('; '),
  );

  if (sessionID === null) {
    ctx.security.record({ kind: 'owner_auth', outcome: 'failed', ...context });

    return buildPageResponse(400, {
      message: 'atc could not continue this approval. Start again from the client.',
    });
  }

  ctx.approvals.recordApproved(sessionID, {
    binding: buildConsentBinding(oauthQuery),
    correlationID: approval.correlationID,
  });

  ctx.security.record({ kind: 'owner_auth', outcome: 'succeeded', ...context });

  const headers = new Headers({ location: new URL(next, ctx.origin).href });

  for (const cookie of setCookies) {
    headers.append('set-cookie', cookie);
  }

  return new Response(null, { status: 302, headers });
}
