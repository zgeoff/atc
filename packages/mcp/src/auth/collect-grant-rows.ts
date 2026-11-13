import { parseJSONStrings } from '@atc/core';

// One token row as atc wrote it before the package: every grant's tokens
// point at the one owner row, and carry the authorization code they came from.
export interface OwnerToken {
  readonly authorizationCodeId: string | null;
  readonly clientId: string;
  readonly scopes: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly revoked: string | null;
}

export interface GrantRow {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly emailVerified: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly clientId: string;
  readonly scopes: string;
  readonly approvedBy: 'passkey';
  readonly limits: null;
  readonly lastUsedAt: string | null;
}

interface GrantSources {
  // Refresh tokens first, so a grant takes its scopes from its live refresh
  // token before an access token.
  readonly tokens: readonly OwnerToken[];
  readonly clientNames: ReadonlyMap<string, string>;
  readonly lastUsedAt: ReadonlyMap<string, string>;
  readonly now: string;
}

// One row per authorization code that a live token still carries. The
// package keeps offline_access out of a grant's scopes.
export function collectGrantRows(sources: GrantSources): GrantRow[] {
  const live = sources.tokens.filter(
    (token) =>
      token.authorizationCodeId !== null && token.revoked === null && token.expiresAt > sources.now,
  );

  const rows = new Map<string, GrantRow>();

  for (const token of live) {
    const id = token.authorizationCodeId;

    if (id === null || rows.has(id)) {
      continue;
    }

    const [createdAt] = sources.tokens
      .filter((other) => other.authorizationCodeId === id)
      .map((other) => other.createdAt)
      .toSorted();

    const scopes = (parseJSONStrings(token.scopes) ?? []).filter(
      (scope) => scope !== 'offline_access',
    );

    rows.set(id, {
      id,
      name: sources.clientNames.get(token.clientId) ?? '',
      email: `${id.toLowerCase()}@grant.invalid`,
      emailVerified: 1,
      createdAt: createdAt ?? token.createdAt,
      updatedAt: sources.now,
      clientId: token.clientId,
      scopes: JSON.stringify(scopes),
      approvedBy: 'passkey',
      limits: null,
      lastUsedAt: sources.lastUsedAt.get(id) ?? null,
    });
  }

  return [...rows.values()];
}
