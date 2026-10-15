import type { buildStubAuthenticator } from './build-stub-authenticator';
import { parsePasskeyPage } from './parse-passkey-page';

interface SignInServer {
  // The address the test reaches the server at, and its public origin,
  // which the browser's page runs on.
  readonly url: string;
  readonly origin: string;

  // The authenticator that holds the owner's passkey.
  readonly authenticator: Pick<ReturnType<typeof buildStubAuthenticator>, 'get'>;
}

// What the browser and the authenticator put in the assertion in place of
// the honest values.
interface SignInCeremony {
  readonly origin?: string;
  readonly rpID?: string;
  readonly userVerified?: boolean;
}

/**
 * Signs in on an MCP HTTP server's login page the way the owner's browser
 * does: opens the login page `login` points at, has the authenticator sign
 * the challenge that page holds, and posts the assertion with the page's
 * signed query. Returns the server's answer to the post unfollowed. Throws
 * when the page holds no sign-in ceremony.
 */
export async function runPasskeySignIn(
  server: SignInServer,
  login: URL,
  ceremony: SignInCeremony = {},
): Promise<Response> {
  const page = await fetch(new URL(`${login.pathname}${login.search}`, server.url));
  const html = await page.text();

  const parsed = parsePasskeyPage(html);

  if (parsed.mode !== 'get') {
    throw new Error('the login page asked to enroll a passkey');
  }

  const assertion = await server.authenticator.get(parsed.options, {
    origin: server.origin,
    ...ceremony,
  });

  return fetch(`${server.url}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { origin: server.url, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      oauth_query: login.search.slice(1),
      credential: JSON.stringify(assertion),
    }),
  });
}
