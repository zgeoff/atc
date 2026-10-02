import { GRANT_SCOPES } from '../shared/grant-scope';

/**
 * The OAuth protected resource metadata (RFC 9728) for atc's MCP endpoint:
 * the resource, the authorization server that issues tokens for it, and the
 * scopes it accepts.
 */
export function buildProtectedResourceMetadata(origin: string): Readonly<Record<string, unknown>> {
  return {
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
    scopes_supported: GRANT_SCOPES,
    bearer_methods_supported: ['header'],
  };
}
