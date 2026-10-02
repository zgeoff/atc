import { createHash } from 'node:crypto';
import { readJSONRecord } from './read-json-record';

interface MCPAuthorizationServer {
  readonly url: string;
  readonly approvals: readonly string[];
}

interface AuthorizedClient {
  readonly clientID: string;
  readonly redirectURI: string;
  readonly code: string;
  readonly verifier: string;
}

/**
 * Drives the OAuth steps before a token exchange against a running MCP HTTP
 * server: registers a client, opens the authorization request, and approves
 * it with the code the server printed, ticking the scopes given. The request
 * asks for the requested scope when one is given and for every scope
 * otherwise. Returns what a token request needs, and throws when any step's
 * response lacks the value the next step depends on.
 */
export async function runMCPAuthorization(
  server: MCPAuthorizationServer,
  scopes: readonly string[],
  requestedScope: string | null = null,
): Promise<AuthorizedClient> {
  const redirectURI = 'https://dots.example/cb';
  const verifier = 'test-verifier-0123456789-abcdefghijklmnopqrstuvwxyz';
  const challenge = createHash('sha256').update(verifier).digest('base64url');

  const registered = await fetch(`${server.url}/register`, {
    method: 'POST',
    body: JSON.stringify({ client_name: 'dots', redirect_uris: [redirectURI] }),
  });

  const registration = await readJSONRecord(registered);

  const clientID = registration['client_id'];

  if (typeof clientID !== 'string') {
    throw new TypeError('registration returned no client_id');
  }

  const authorize = new URL(`${server.url}/authorize`);

  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientID,
    redirect_uri: redirectURI,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'state-1',
    ...(requestedScope === null ? {} : { scope: requestedScope }),
  }).toString();

  const consent = await fetch(authorize);
  const page = await consent.text();

  const pendingID = /name="pending" value="(?<id>[^"]+)"/.exec(page)?.groups?.['id'];

  if (pendingID === undefined) {
    throw new Error('consent page holds no pending approval');
  }

  const approvalCode = /code (?<code>\w{4}-\w{4})/.exec(server.approvals.at(-1) ?? '')?.groups?.[
    'code'
  ];

  if (approvalCode === undefined) {
    throw new Error('server printed no approval code');
  }

  const form = new URLSearchParams({ pending: pendingID, code: approvalCode, decision: 'approve' });

  for (const scope of scopes) {
    form.append('scope', scope);
  }

  const approved = await fetch(`${server.url}/authorize`, {
    method: 'POST',
    redirect: 'manual',
    headers: { origin: server.url, 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });

  const location = approved.headers.get('location');

  if (location === null) {
    throw new Error('approval did not redirect');
  }

  const code = new URL(location).searchParams.get('code');

  if (code === null) {
    throw new Error('approval redirect holds no authorization code');
  }

  return { clientID, redirectURI, code, verifier };
}
