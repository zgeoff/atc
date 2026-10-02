import { isAllowedRedirectURI } from './is-allowed-redirect-uri';
import type { HTTPServerContext } from './types';

// Longer client names are cut, since the operator reads them in a terminal line.
const MAX_CLIENT_NAME = 100;

/**
 * Answers `POST /register`, OAuth dynamic client registration (RFC 7591) for
 * public clients only. The daemon keeps the client and mints its id.
 */
export async function answerRegisterRequest(
  ctx: HTTPServerContext,
  body: string,
): Promise<Response> {
  let metadata: unknown;

  try {
    metadata = JSON.parse(body);
  } catch {
    return buildRegisterError('invalid_client_metadata', 'the body is not JSON');
  }

  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
    return buildRegisterError('invalid_client_metadata', 'the body is not a JSON object');
  }

  const record: Readonly<Record<string, unknown>> = Object.fromEntries(Object.entries(metadata));
  const uris = record['redirect_uris'];

  if (
    !Array.isArray(uris) ||
    uris.length === 0 ||
    !uris.every((uri) => typeof uri === 'string' && isAllowedRedirectURI(uri))
  ) {
    return buildRegisterError(
      'invalid_redirect_uri',
      'redirect_uris must list https URIs, or http URIs on a loopback host',
    );
  }

  const authMethod = record['token_endpoint_auth_method'];

  if (authMethod !== undefined && authMethod !== 'none') {
    return buildRegisterError(
      'invalid_client_metadata',
      'atc registers public clients only; token_endpoint_auth_method must be none',
    );
  }

  const rawName = record['client_name'];

  const name =
    typeof rawName === 'string' && rawName.trim() !== ''
      ? rawName.trim().slice(0, MAX_CLIENT_NAME)
      : 'unnamed client';

  const redirectURIs = uris.filter((uri): uri is string => typeof uri === 'string');

  const registered = await ctx.caller.sendRequest('grant.registerClient', { name, redirectURIs });

  return Response.json(
    {
      client_id: registered['clientID'],
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: name,
      redirect_uris: redirectURIs,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    },
    { status: 201, headers: { 'cache-control': 'no-store' } },
  );
}

function buildRegisterError(error: string, description: string): Response {
  return Response.json({ error, error_description: description }, { status: 400 });
}
