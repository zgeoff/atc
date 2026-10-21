// only the columns atc reads and writes itself: better-auth owns the tables and
// their migrations. Dates are ISO 8601 strings and string lists are JSON arrays.
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

  // The owner's passkeys: the credential id and its COSE public key, both
  // base64url, the signature counter the authenticator last returned, and
  // its transports as a JSON array.
  readonly atc_passkey: {
    readonly id: string;
    readonly public_key: string;
    readonly counter: number;
    readonly transports: string;
    readonly created_at: string;
    readonly last_used_at: string | null;
  };

  // The hash of each enrollment token a host command minted and no passkey
  // has used yet.
  readonly atc_enrollment_token: {
    readonly token_hash: string;
    readonly created_at: string;
    readonly expires_at: string;
  };
}
