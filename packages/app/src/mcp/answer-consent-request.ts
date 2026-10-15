import { isRecord } from '@atc/core/is-record';
import { GRANT_SCOPES } from '../shared/grant-scope';
import { normalizeClientName } from '../shared/normalize-client-name';
import { APPROVAL_WINDOW_SECONDS } from './approval-window-seconds';
import { buildConsentBinding } from './build-consent-binding';
import { buildPageResponse } from './build-page-response';
import { findClientName } from './find-client-name';
import { findOwnerSessionID } from './find-owner-session-id';
import { renderConsentPage } from './render-consent-page';
import type { HTTPServerContext, Requester, SecurityOutcome } from './types';
import { verifyOAuthQuery } from './verify-oauth-query';

interface ConsentRequest {
  readonly method: 'GET' | 'POST';
  readonly url: URL;
  readonly cookie: string | null;
  readonly body: string;
  readonly requester: Requester;
}

/**
 * Answers `GET /consent` and `POST /consent`. Both refuse a request unless
 * its signed query is valid, its prompt no longer asks for a login, and its
 * owner session is the one a passkey signed in for this same request.
 * The page lists the scopes the client requested, with only `read` ticked to
 * start. The form goes to better-auth's consent endpoint with the ticked
 * scopes plus `offline_access`; better-auth refuses any scope the client did
 * not request. Allowing nothing denies the request. Either way the browser
 * returns to the client with its owner session cookie cleared.
 *
 * One login answers one consent: the answer ends the session's binding, so
 * it can approve nothing else. An answer that issues no authorization code
 * deletes the session outright. One that issues a code leaves the session
 * only until the code expires, since the code exchange needs it, and the
 * exchange deletes it.
 *
 * Each answer writes one `consent` security event with the request's
 * correlation id: `allowed` when the answer issued an authorization code,
 * else `denied`, with `none_ticked` when allow came with no scope ticked.
 */
export async function answerConsentRequest(
  ctx: HTTPServerContext,
  request: ConsentRequest,
): Promise<Response> {
  const form = new URLSearchParams(request.body);

  const oauthQuery =
    request.method === 'GET' ? request.url.search.slice(1) : (form.get('oauth_query') ?? '');

  const verified = await verifyConsentRequest(ctx, oauthQuery, request.cookie);

  if (verified === null) {
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

  const sessionID = verified.sessionID;

  ctx.approvals.removeApproved(sessionID);

  const ticked = form.getAll('scope');
  const scopes = GRANT_SCOPES.filter((scope) => ticked.includes(scope));
  const allow = form.get('decision') === 'approve';
  const accept = allow && scopes.length > 0;

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

  const issuedCode =
    consented.ok && typeof next === 'string' && new URL(next).searchParams.has('code');

  await (issuedCode
    ? ctx.store.db
        .updateTable('session')
        .set({
          expiresAt: new Date(ctx.clock.now() + APPROVAL_WINDOW_SECONDS * 1000).toISOString(),
        })
        .where('id', '=', sessionID)
        .execute()
    : ctx.store.db.deleteFrom('session').where('id', '=', sessionID).execute());

  const params = new URLSearchParams(oauthQuery);

  const clientID = params.get('client_id') ?? '';
  const redirectURI = params.get('redirect_uri') ?? '';

  const storedName = await findClientName(ctx.store.db, clientID);

  ctx.security.record({
    ...pickConsentOutcome(issuedCode, allow && !accept),
    path: request.url.pathname,
    requester: request.requester,
    client: { id: clientID, name: normalizeClientName(storedName) },
    ...(URL.canParse(redirectURI) ? { redirectHost: new URL(redirectURI).host } : {}),
    correlationID: verified.correlationID,
  });

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

// The owner session id and the request's correlation id when the request
// may reach consent, else null. A query still asking for a login is one
// better-auth signed for the login page, which no passkey sign-in carried
// past.
async function verifyConsentRequest(
  ctx: HTTPServerContext,
  oauthQuery: string,
  cookie: string | null,
): Promise<{ sessionID: string; correlationID: string } | null> {
  const authContext = await ctx.store.auth.$context;

  if (!(await verifyOAuthQuery(oauthQuery, authContext.secret, ctx.clock.now()))) {
    return null;
  }

  const prompt = (new URLSearchParams(oauthQuery).get('prompt') ?? '').split(' ');

  if (prompt.includes('login')) {
    return null;
  }

  const sessionID = await findOwnerSessionID(ctx, cookie);

  const approved = sessionID === null ? null : ctx.approvals.findApproved(sessionID);

  if (
    sessionID === null ||
    approved === null ||
    approved.binding !== buildConsentBinding(oauthQuery)
  ) {
    return null;
  }

  return { sessionID, correlationID: approved.correlationID };
}

// `noneTicked` is an allow sent with no scope ticked, which denies.
function pickConsentOutcome(issuedCode: boolean, noneTicked: boolean): SecurityOutcome {
  if (issuedCode) {
    return { kind: 'consent', outcome: 'allowed' };
  }

  return noneTicked
    ? { kind: 'consent', outcome: 'denied', reason: 'none_ticked' }
    : { kind: 'consent', outcome: 'denied' };
}
