import { GRANT_SCOPES } from '../shared/grant-scope';
import { normalizeClientName } from '../shared/normalize-client-name';
import { isRecord } from '../shared/report';
import { buildConsentBinding } from './build-consent-binding';
import { buildPageResponse } from './build-page-response';
import { findClientName } from './find-client-name';
import { findOwnerSessionID } from './find-owner-session-id';
import { renderConsentPage } from './render-consent-page';
import type { HTTPServerContext } from './types';
import { verifyOAuthQuery } from './verify-oauth-query';

interface ConsentRequest {
  readonly method: 'GET' | 'POST';
  readonly url: URL;
  readonly cookie: string | null;
  readonly body: string;
}

/**
 * Answers `GET /consent` and `POST /consent`. Both refuse a request unless
 * its signed query is valid, its prompt no longer asks for a login, and its
 * owner session is the one an approval code signed in for this same request.
 * The page lists the scopes the client requested, with only `read` ticked to
 * start. The form goes to
 * better-auth's consent endpoint with the ticked scopes plus
 * `offline_access`; better-auth refuses any scope the client did not request.
 * Allowing nothing denies the request. Either way the browser returns to the
 * client, and its owner session cookie is cleared, so the next authorization
 * starts with no session.
 */
export async function answerConsentRequest(
  ctx: HTTPServerContext,
  request: ConsentRequest,
): Promise<Response> {
  const form = new URLSearchParams(request.body);

  const oauthQuery =
    request.method === 'GET' ? request.url.search.slice(1) : (form.get('oauth_query') ?? '');

  const sessionID = await verifyConsentRequest(ctx, oauthQuery, request.cookie);

  if (sessionID === null) {
    return buildPageResponse(400, {
      message: 'This approval expired or was already used. Start again from the client.',
    });
  }

  if (request.method === 'GET') {
    const params = new URLSearchParams(oauthQuery);

    const redirectURI = params.get('redirect_uri') ?? '';
    const requested = (params.get('scope') ?? '').split(' ');

    const storedName = await findClientName(ctx.store.db, params.get('client_id') ?? '');

    const page = renderConsentPage({
      oauthQuery,
      clientName: normalizeClientName(storedName),
      redirectURI,
      scopes: GRANT_SCOPES.filter((scope) => requested.includes(scope)),
    });

    // The form's answer redirects to the client, which the page's form-action
    // policy has to allow.
    const formTargets = URL.canParse(redirectURI) ? [new URL(redirectURI).origin] : [];

    return buildPageResponse(200, { page }, formTargets);
  }

  const ticked = form.getAll('scope');
  const scopes = GRANT_SCOPES.filter((scope) => ticked.includes(scope));
  const accept = form.get('decision') === 'approve' && scopes.length > 0;

  const choice = JSON.stringify({
    accept,
    ...(accept ? { scope: [...scopes, 'offline_access'].join(' ') } : {}),
    oauth_query: oauthQuery,
  });

  const forwarded = new Request(`${ctx.origin}/oauth2/consent`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      origin: ctx.origin,
      ...(request.cookie === null ? {} : { cookie: request.cookie }),
    },
    body: choice,
  });

  const consented = await ctx.store.auth.handler(forwarded);
  const answer: unknown = await consented.json();

  const next = isRecord(answer) ? (answer['url'] ?? answer['redirect_uri']) : undefined;

  if (!consented.ok || typeof next !== 'string') {
    return buildPageResponse(400, {
      message: 'atc could not record this choice. Start again from the client.',
    });
  }

  const authContext = await ctx.store.auth.$context;

  const sessionCookie = authContext.authCookies.sessionToken;
  const secure = sessionCookie.attributes.secure === true ? '; Secure' : '';

  return new Response(null, {
    status: 302,
    headers: {
      location: next,
      'set-cookie': `${sessionCookie.name}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax${secure}`,
    },
  });
}

// The owner session id when the request may reach consent, else null. A
// query still asking for a login is one better-auth signed for the login
// page, which the approval code never carried past.
async function verifyConsentRequest(
  ctx: HTTPServerContext,
  oauthQuery: string,
  cookie: string | null,
): Promise<string | null> {
  const authContext = await ctx.store.auth.$context;

  if (!(await verifyOAuthQuery(oauthQuery, authContext.secret))) {
    return null;
  }

  const prompt = (new URLSearchParams(oauthQuery).get('prompt') ?? '').split(' ');

  if (prompt.includes('login')) {
    return null;
  }

  const sessionID = await findOwnerSessionID(ctx, cookie);

  if (
    sessionID === null ||
    ctx.approvals.findApproved(sessionID) !== buildConsentBinding(oauthQuery)
  ) {
    return null;
  }

  return sessionID;
}
