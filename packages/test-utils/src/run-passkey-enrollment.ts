import type { buildStubAuthenticator } from './build-stub-authenticator';
import { parsePasskeyPage } from './parse-passkey-page';

interface EnrollmentServer {
  // The address the test reaches the server at, and its public origin,
  // which the browser's page runs on.
  readonly url: string;
  readonly origin: string;
}

/**
 * Enrolls the authenticator's passkey on a running MCP HTTP server the way
 * the owner's browser does: posts the enrollment token to `/enroll`, runs
 * the creation options the page returns through the authenticator on the
 * server's origin, and posts the new passkey with the token. Throws when
 * either step's response is not the one that leads on.
 */
export async function runPasskeyEnrollment(
  server: EnrollmentServer,
  token: string,
  authenticator: Pick<ReturnType<typeof buildStubAuthenticator>, 'create'>,
): Promise<void> {
  const asked = await fetch(`${server.url}/enroll`, {
    method: 'POST',
    headers: { origin: server.url, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }),
  });

  const page = await asked.text();

  if (asked.status !== 200) {
    throw new Error(`the enrollment token did not reach the passkey prompt: ${asked.status}`);
  }

  const ceremony = parsePasskeyPage(page);

  if (ceremony.mode !== 'create') {
    throw new Error('the enrollment page asked for a sign-in');
  }

  const registration = await authenticator.create(ceremony.options, { origin: server.origin });

  const enrolled = await fetch(`${server.url}/enroll`, {
    method: 'POST',
    headers: { origin: server.url, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token, credential: JSON.stringify(registration) }),
  });

  if (enrolled.status !== 200) {
    throw new Error(`the passkey did not enroll: ${enrolled.status} ${await enrolled.text()}`);
  }
}
