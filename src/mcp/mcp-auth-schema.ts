/**
 * The columns of the authorization server's database that atc reads and
 * writes itself. better-auth owns the tables and their migrations; dates are
 * ISO 8601 strings and string lists are JSON arrays.
 */
export interface MCPAuthSchema {
  readonly oauthClient: {
    readonly id: string;
    readonly clientId: string;
    readonly name: string | null;
    readonly redirectUris: string;
    readonly createdAt: string | null;
  };
  readonly oauthAccessToken: {
    readonly id: string;
    readonly token: string;
    readonly clientId: string;
    readonly sessionId: string | null;
    readonly authorizationCodeId: string | null;
  };
  readonly oauthRefreshToken: {
    readonly id: string;
    readonly clientId: string;
    readonly sessionId: string | null;
    readonly authorizationCodeId: string | null;
    readonly scopes: string;
    readonly createdAt: string;
    readonly expiresAt: string;
    readonly revoked: string | null;
  };
  readonly oauthConsent: { readonly id: string; readonly clientId: string };
  readonly oauthResource: { readonly identifier: string };
  readonly session: { readonly id: string; readonly expiresAt: string };

  // When each grant last reached /mcp, keyed by the grant's authorization code id.
  readonly atc_grant_use: { readonly grant_id: string; readonly last_used_at: string };
}
