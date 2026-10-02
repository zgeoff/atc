import { GRANT_SCOPES } from '../shared/grant-scope';

/**
 * The OAuth authorization server metadata (RFC 8414) atc serves for its
 * public origin. It advertises S256 PKCE only, public clients only, client
 * registration by metadata document or by registration request, and the
 * `iss` parameter on every authorization response (RFC 9207).
 */
export function buildAuthorizationServerMetadata(
  origin: string,
): Readonly<Record<string, unknown>> {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/token`,
    registration_endpoint: `${origin}/register`,
    scopes_supported: GRANT_SCOPES,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: true,
  };
}
