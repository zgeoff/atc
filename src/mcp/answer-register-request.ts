import { DaemonError } from '../protocol/daemon-error';
import { normalizeClientName } from '../shared/normalize-client-name';
import { isAllowedRedirectURI } from './is-allowed-redirect-uri';
import type { HTTPServerContext } from './types';

// Registration is unauthenticated, so what one client may store is bounded.
const MAX_REDIRECT_URIS = 5;
const MAX_REDIRECT_URI_LENGTH = 2000;

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
    Array.isArray(uris) &&
    (uris.length > MAX_REDIRECT_URIS ||
      uris.some((uri) => typeof uri === 'string' && uri.length > MAX_REDIRECT_URI_LENGTH))
  ) {
    return buildRegisterError(
      'invalid_redirect_uri',
      `redirect_uris may list at most ${MAX_REDIRECT_URIS} URIs of at most ${MAX_REDIRECT_URI_LENGTH} characters each`,
    );
  }

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

  const name = normalizeClientName(record['client_name']);
  const redirectURIs = uris.filter((uri): uri is string => typeof uri === 'string');
  let registered: Readonly<Record<string, unknown>>;

  try {
    registered = await ctx.caller.sendRequest('grant.registerClient', { name, redirectURIs });
  } catch (error) {
    if (error instanceof DaemonError && error.code === 'at_capacity') {
      return Response.json(
        {
          error: 'temporarily_unavailable',
          error_description: 'too many clients are waiting for approval; try again later',
        },
        { status: 503, headers: { 'retry-after': '600' } },
      );
    }

    throw error;
  }

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
