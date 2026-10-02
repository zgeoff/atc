import { GRANT_SCOPES } from '../shared/grant-scope';
import { normalizeClientName } from '../shared/normalize-client-name';
import { isRecord } from '../shared/report';
import { buildPageResponse } from './build-page-response';
import { findClientName } from './find-client-name';
import { renderConsentPage } from './render-consent-page';
import type { HTTPServerContext } from './types';

interface ConsentRequest {
  readonly method: 'GET' | 'POST';
  readonly url: URL;
  readonly cookie: string | null;
  readonly body: string;
}

/**
 * Answers `GET /consent` and `POST /consent`. The page lists the scopes the
 * client requested, with only `read` ticked to start. The form goes to
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
  if (request.method === 'GET') {
    const params = request.url.searchParams;
    const redirectURI = params.get('redirect_uri') ?? '';
    const requested = (params.get('scope') ?? '').split(' ');

    const storedName = await findClientName(ctx.store.db, params.get('client_id') ?? '');

    const page = renderConsentPage({
      oauthQuery: request.url.search.slice(1),
      clientName: normalizeClientName(storedName),
      redirectURI,
      scopes: GRANT_SCOPES.filter((scope) => requested.includes(scope)),
    });

    // The form's answer redirects to the client, which the page's form-action
    // policy has to allow.
    const formTargets = URL.canParse(redirectURI) ? [new URL(redirectURI).origin] : [];

    return buildPageResponse(200, { page }, formTargets);
  }

  const form = new URLSearchParams(request.body);

  const ticked = form.getAll('scope');
  const scopes = GRANT_SCOPES.filter((scope) => ticked.includes(scope));
  const accept = form.get('decision') === 'approve' && scopes.length > 0;

  const choice = JSON.stringify({
    accept,
    ...(accept ? { scope: [...scopes, 'offline_access'].join(' ') } : {}),
    oauth_query: form.get('oauth_query') ?? '',
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
