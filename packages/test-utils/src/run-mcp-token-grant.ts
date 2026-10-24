import { readJSONRecord } from './read-json-record';
import { runMCPAuthorization } from './run-mcp-authorization';

type MCPTokenGrantServer = Parameters<typeof runMCPAuthorization>[0];

type MCPTokenGrantRequest = Parameters<typeof runMCPAuthorization>[1];

interface MCPTokenGrant {
  readonly accessToken: string;

  // The scopes the token holds, as the token endpoint returned them.
  readonly scope: string;
}

// Runs the authorization a hosted assistant runs, through passkey sign-in and
// consent, and exchanges its code at the token endpoint.
export async function runMCPTokenGrant(
  server: MCPTokenGrantServer,
  request: MCPTokenGrantRequest,
): Promise<MCPTokenGrant> {
  const authorized = await runMCPAuthorization(server, request);

  const exchanged = await fetch(`${server.url}/oauth2/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: authorized.code,
      redirect_uri: request.redirectURI,
      client_id: request.clientID,
      code_verifier: authorized.verifier,
    }),
  });

  const tokens = await readJSONRecord(exchanged);

  const accessToken = tokens['access_token'];
  const scope = tokens['scope'];

  if (typeof accessToken !== 'string' || typeof scope !== 'string') {
    throw new TypeError(`the token endpoint answered ${exchanged.status} with no token`);
  }

  return { accessToken, scope };
}
