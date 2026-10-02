import { normalizeClientName } from '../shared/normalize-client-name';
import { isAllowedRedirectURI } from './is-allowed-redirect-uri';
import type { OAuthClientView } from './types';

/**
 * Reads a client ID metadata document fetched from its own client id URL.
 * The document must name that same URL as its `client_id`, list at least one
 * allowed redirect URI, and leave client authentication at `none`.
 */
export function parseClientMetadataDocument(
  clientID: string,
  body: unknown,
): OAuthClientView | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return null;
  }

  const document: Readonly<Record<string, unknown>> = Object.fromEntries(Object.entries(body));
  const redirectURIs = document['redirect_uris'];
  const authMethod = document['token_endpoint_auth_method'];

  if (document['client_id'] !== clientID || !Array.isArray(redirectURIs)) {
    return null;
  }

  if (authMethod !== undefined && authMethod !== 'none') {
    return null;
  }

  const uris = redirectURIs.filter((uri): uri is string => typeof uri === 'string');

  if (
    uris.length === 0 ||
    uris.length !== redirectURIs.length ||
    !uris.every((uri) => isAllowedRedirectURI(uri))
  ) {
    return null;
  }

  return {
    clientID,
    name: normalizeClientName(document['client_name'], new URL(clientID).hostname),
    redirectURIs: uris,
    verified: true,
  };
}
