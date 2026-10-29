import { isRecord } from '@atc/core';
import { GRANT_SCOPES } from '@atcx/contract';
import { buildPageResponse } from '../http/build-page-response';
import { APPROVAL_WINDOW_SECONDS } from './approval-window-seconds';
import { buildConsentBinding } from './build-consent-binding';
import { normalizeClientName } from './normalize-client-name';
import { readClientName } from './read-client-name';
import { readOwnerSessionID } from './read-owner-session-id';
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

    const storedName = await readClientName(ctx.store.db, params.get('client_id') ?? '');

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

  // either answer ends the session's binding, so one sign-in approves one request.
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

  // the code exchange still needs the session, so it stays until the code expires;
  // an answer that issued no code deletes it now.
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

  const storedName = await readClientName(ctx.store.db, clientID);

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

async function verifyConsentRequest(
  ctx: HTTPServerContext,
  oauthQuery: string,
  cookie: string | null,
): Promise<{ sessionID: string; correlationID: string } | null> {
  const authContext = await ctx.store.auth.$context;

  if (!(await verifyOAuthQuery(oauthQuery, authContext.secret, ctx.clock.now()))) {
    return null;
  }

  // a query still asking for a login is one better-auth signed for the login page,
  // which no passkey sign-in carried past.
  const prompt = (new URLSearchParams(oauthQuery).get('prompt') ?? '').split(' ');

  if (prompt.includes('login')) {
    return null;
  }

  const sessionID = await readOwnerSessionID(ctx, cookie);

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
