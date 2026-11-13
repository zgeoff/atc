import type { Database } from 'bun:sqlite';
import type { OAuthClientID } from '@zgeoff/mcp-auth';
import { toTagged } from '@zgeoff/std';

export interface OwnerClientInput {
  readonly name: string;
}

export interface OwnerClient {
  readonly clientID: OAuthClientID;
  readonly name: string;
}

// A client as atc's own `atc clients add` wrote it before atc moved to
// @zgeoff/mcp-auth: no code here makes it now.
export function seedOwnerClient(sqlite: Database, input: OwnerClientInput): OwnerClient {
  const clientID = toTagged<OAuthClientID>(crypto.randomUUID().replaceAll('-', ''));

  const now = new Date().toISOString();

  sqlite.run(
    'insert into "oauthClient" ("id", "clientId", "name", "redirectUris", "scopes", "clientCredentialsScopes", "tokenEndpointAuthMethod", "grantTypes", "responseTypes", "applicationType", "requirePKCE", "disabled", "createdAt", "updatedAt") values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      crypto.randomUUID(),
      clientID,
      input.name,
      '["https://claude.ai/api/mcp/auth_callback"]',
      '["read","message","spawn","kill","offline_access"]',
      '[]',
      'none',
      '["authorization_code","refresh_token"]',
      '["code"]',
      'web',
      1,
      0,
      now,
      now,
    ],
  );

  return { clientID, name: input.name };
}
