import { createHash } from 'node:crypto';
import type { buildStubAuthenticator } from './build-stub-authenticator';
import { runPasskeySignIn } from './run-passkey-sign-in';

interface MCPAuthorizationServer {
  readonly url: string;
  readonly origin: string;

  // The authenticator that holds the owner's enrolled passkey.
  readonly authenticator: Pick<ReturnType<typeof buildStubAuthenticator>, 'signAssertion'>;
}

interface MCPAuthorizationRequest {
  readonly clientID: string;
  readonly redirectURI: string;

  // The scope the client requests.
  readonly scope: string;

  // The scopes the operator leaves ticked on the consent page.
  readonly ticked: readonly string[];
}

interface MCPAuthorization {
  // The consent page the passkey sign-in sent the browser to.
  readonly consent: URL;

  // Where the consent page sent the browser back to.
  readonly callback: URL;
  readonly code: string;
  readonly verifier: string;
}

export async function runMCPAuthorization(
  server: MCPAuthorizationServer,
  request: MCPAuthorizationRequest,
): Promise<MCPAuthorization> {
  const verifier = `test-verifier-${crypto.randomUUID()}`;
  const challenge = createHash('sha256').update(verifier).digest('base64url');

  const authorize = new URL(`${server.url}/oauth2/authorize`);

  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: request.clientID,
    redirect_uri: request.redirectURI,
    scope: request.scope,
    state: 'state-1',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: `${server.origin}/mcp`,
  }).toString();

  const authorized = await fetch(authorize, { redirect: 'manual' });

  const login = new URL(authorized.headers.get('location') ?? '/', server.url);

  if (login.pathname !== '/login') {
    throw new Error(`authorization did not reach the login page: ${login.href}`);
  }

  const signedIn = await runPasskeySignIn(server, login);

  const consent = new URL(signedIn.headers.get('location') ?? '/', server.url);

  const cookie = signedIn.headers
    .getSetCookie()
    .map((line) => line.split(';')[0])
    .join('; ');

  if (consent.pathname !== '/consent') {
    throw new Error(`the passkey sign-in did not reach the consent page: ${consent.href}`);
  }

  const form = new URLSearchParams({ oauth_query: consent.search.slice(1), decision: 'approve' });

  for (const scope of request.ticked) {
    form.append('scope', scope);
  }

  const consented = await fetch(`${server.url}/consent`, {
    method: 'POST',
    redirect: 'manual',
    headers: { origin: server.url, cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
  });

  const location = consented.headers.get('location');

  if (location === null) {
    throw new Error(`consent did not redirect: ${consented.status} ${await consented.text()}`);
  }

  const callback = new URL(location);

  const code = callback.searchParams.get('code');

  if (code === null) {
    throw new Error(`the consent redirect holds no authorization code: ${location}`);
  }

  return { consent, callback, code, verifier };
}
