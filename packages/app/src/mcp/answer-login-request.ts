import { isRecord } from '@atc/core';
import { buildConsentBinding } from './build-consent-binding';
import { buildPageResponse } from './build-page-response';
import { PASSKEY_SCRIPT } from './passkey-script';
import { readOwnerSessionID } from './read-owner-session-id';
import { renderLoginPage } from './render-login-page';
import type { HTTPServerContext, OwnerAuthFailure, Requester } from './types';
import { verifyPasskeyAssertion } from './verify-passkey-assertion';
import { verifySessionPasskey } from './verify-session-passkey';

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

  const enrolled = await probePasskey(ctx);

  if (method === 'GET') {
    return enrolled
      ? buildSignInResponse(ctx, 200, view, null)
      : buildPageResponse(200, { page: renderLoginPage({ ...view, options: null, error: null }) });
  }

  // Read before the assertion is checked, since a sign-in or the last
  // failure ends the approval.
  const context = {
    path: url.pathname,
    requester,
    client: { id: approval.clientID, name: approval.clientName },
    correlationID: approval.correlationID,
  };

  if (!enrolled) {
    ctx.security.record({
      kind: 'owner_auth',
      outcome: 'failed',
      reason: 'not_enrolled',
      ...context,
    });

    return buildPageResponse(400, {
      page: renderLoginPage({ ...view, options: null, error: null }),
    });
  }

  // the challenge is taken whether or not the assertion verifies, so it counts once.
  const taken = ctx.approvals.claimChallenge(oauthQuery);

  const passkeyID =
    taken.kind === 'taken'
      ? await verifyAssertion(ctx, form.get('credential') ?? '', taken.challenge)
      : null;

  if (passkeyID === null) {
    const reason: OwnerAuthFailure = taken.kind === 'expired' ? 'expired' : 'assertion_failed';

    if (ctx.approvals.recordFailure(oauthQuery) === 'locked') {
      ctx.security.record({ kind: 'owner_auth', outcome: 'failed', reason: 'locked', ...context });

      return buildPageResponse(400, {
        message: 'Too many failed sign-ins. Start again from the client.',
      });
    }

    ctx.security.record({ kind: 'owner_auth', outcome: 'failed', reason, ...context });

    const error =
      reason === 'expired'
        ? 'The sign-in took too long. Try again.'
        : 'That passkey did not sign you in. Try again with a passkey enrolled for atc.';

    return buildSignInResponse(ctx, 400, view, error);
  }

  ctx.approvals.removePending(oauthQuery);

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

  const sessionID = await readOwnerSessionID(
    ctx,
    setCookies.map((line) => line.split(';')[0]).join('; '),
  );

  if (sessionID === null) {
    ctx.security.record({ kind: 'owner_auth', outcome: 'failed', ...context });

    return buildPageResponse(400, {
      message: 'atc could not continue this approval. Start again from the client.',
    });
  }

  // A passkey removal or reset that committed after the assertion verified
  // and before the session existed deleted no session, so the session
  // carries on only while the passkey that signed is still enrolled.
  if (!(await verifySessionPasskey(ctx.store.db, { sessionID, passkeyID }))) {
    ctx.security.record({
      kind: 'owner_auth',
      outcome: 'failed',
      reason: 'not_enrolled',
      ...context,
    });

    return buildPageResponse(400, {
      message: 'The passkey that signed you in is no longer enrolled. Start again from the client.',
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

// The enrolled passkey the posted credential is an assertion of, for the
// challenge the caller claimed, or null.
function verifyAssertion(
  ctx: HTTPServerContext,
  credential: string,
  challenge: string,
): Promise<string | null> {
  return verifyPasskeyAssertion(ctx.store.db, {
    credential,
    challenge,
    origin: ctx.origin,
    rpID: new URL(ctx.origin).hostname,
    now: ctx.clock.now(),
  });
}

async function probePasskey(ctx: HTTPServerContext): Promise<boolean> {
  const row = await ctx.store.db.selectFrom('atc_passkey').select('id').limit(1).executeTakeFirst();

  return row !== undefined;
}

// How long the browser's passkey prompt waits, in milliseconds.
const PROMPT_TIMEOUT_MS = 120_000;

// What the sign-in page shows about its request.
interface LoginView {
  readonly oauthQuery: string;
  readonly clientName: string;
  readonly redirectURI: string;
}

// The sign-in page with a fresh challenge for its request. The options
// list no credential, so the authenticator offers the passkeys it holds
// for atc's RP ID, and they require user verification.
function buildSignInResponse(
  ctx: HTTPServerContext,
  status: number,
  view: LoginView,
  error: string | null,
): Response {
  const challenge = ctx.approvals.mintChallenge(view.oauthQuery);

  if (challenge === null) {
    return buildPageResponse(400, {
      message: 'This approval expired or was already used. Start again from the client.',
    });
  }

  const options = {
    challenge,
    rpId: new URL(ctx.origin).hostname,
    timeout: PROMPT_TIMEOUT_MS,
    userVerification: 'required',
    allowCredentials: [],
  };

  return buildPageResponse(
    status,
    { page: renderLoginPage({ ...view, options, error }) },
    [],
    [PASSKEY_SCRIPT.policySource],
  );
}
