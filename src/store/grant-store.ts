import type { Kysely, Transaction } from 'kysely';
import { GRANT_SCOPES } from '../shared/grant-scope';
import type { GrantScope } from '../shared/grant-scope';
import type { StateStoreSchema } from './run-migrations';

interface GrantLifetimes {
  // Milliseconds an access token stays valid.
  readonly accessMs: number;

  // Milliseconds a refresh token stays valid; each rotation starts a fresh span.
  readonly refreshMs: number;
}

interface NewGrant extends GrantLifetimes {
  readonly id: string;
  readonly clientID: string;
  readonly clientName: string;
  readonly scopes: readonly GrantScope[];
  readonly resource: string;
  readonly accessHash: string;
  readonly refreshHash: string;
  readonly now: number;
}

interface GrantRefresh extends GrantLifetimes {
  readonly refreshHash: string;
  readonly accessHash: string;
  readonly nextRefreshHash: string;
  readonly clientID: string;
  readonly resource: string;
  readonly now: number;

  // How long after a rotation the old refresh token may be presented again
  // and still count as a retry of that rotation.
  readonly retryWindowMs: number;
}

/**
 * One live grant as `grant.list` reports it: never a token or a hash.
 */
export interface GrantSummary {
  readonly id: string;
  readonly clientID: string;
  readonly clientName: string;
  readonly scopes: readonly GrantScope[];
  readonly resource: string;
  readonly createdAt: number;
  readonly lastUsedAt: number | null;
}

/**
 * A verified access token: the grant it belongs to and what that grant allows.
 */
export interface GrantAccess {
  readonly grantID: string;
  readonly scopes: readonly GrantScope[];
}

export type GrantRefreshOutcome =
  | ({ readonly kind: 'rotated' } & GrantAccess)
  | { readonly kind: 'revoked' }
  | { readonly kind: 'invalid' };

/**
 * A registered OAuth client, kept so its id stays valid for as long as a
 * grant uses it.
 */
export interface OAuthClient {
  readonly clientID: string;
  readonly name: string;
  readonly redirectURIs: readonly string[];
}

/**
 * The grants remote MCP clients hold, stored as token hashes only. Each grant
 * has one live access token and one live refresh token. A refresh rotates
 * both; presenting a spent refresh token again revokes the grant, except as a
 * retry of the rotation it started.
 */
export class GrantStore {
  private readonly db: Kysely<StateStoreSchema>;

  constructor(db: Kysely<StateStoreSchema>) {
    this.db = db;
  }

  async createClient(client: OAuthClient, now: number): Promise<void> {
    await this.db
      .insertInto('oauth_clients')
      .values({
        client_id: client.clientID,
        name: client.name,
        redirect_uris: JSON.stringify(client.redirectURIs),
        created_at: now,
      })
      .execute();
  }

  async findClient(clientID: string): Promise<OAuthClient | null> {
    const row = await this.db
      .selectFrom('oauth_clients')
      .selectAll()
      .where('client_id', '=', clientID)
      .executeTakeFirst();

    if (row === undefined) {
      return null;
    }

    return {
      clientID: row.client_id,
      name: row.name,
      redirectURIs: parseURIList(row.redirect_uris),
    };
  }

  async createGrant(grant: NewGrant): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await trx
        .insertInto('grants')
        .values({
          id: grant.id,
          client_id: grant.clientID,
          client_name: grant.clientName,
          scopes: grant.scopes.join(' '),
          resource: grant.resource,
          created_at: grant.now,
          last_used_at: null,
          revoked_at: null,
        })
        .execute();

      await createTokenPair(trx, grant.id, grant.accessHash, grant.refreshHash, null, grant);
    });
  }

  // A token is accepted only for the resource its grant was bound to.
  async verifyAccessToken(
    hash: string,
    resource: string,
    now: number,
  ): Promise<GrantAccess | null> {
    const row = await this.db
      .selectFrom('grant_tokens')
      .innerJoin('grants', 'grants.id', 'grant_tokens.grant_id')
      .select(['grants.id', 'grants.scopes', 'grants.resource', 'grants.revoked_at'])
      .select(['grant_tokens.expires_at', 'grant_tokens.used_at'])
      .where('grant_tokens.hash', '=', hash)
      .where('grant_tokens.kind', '=', 'access')
      .executeTakeFirst();

    if (row === undefined || row.revoked_at !== null || row.expires_at <= now) {
      return null;
    }

    if (row.resource !== resource) {
      return null;
    }

    if (row.used_at === null) {
      await this.db
        .updateTable('grant_tokens')
        .set({ used_at: now })
        .where('hash', '=', hash)
        .execute();
    }

    await this.db
      .updateTable('grants')
      .set({ last_used_at: now })
      .where('id', '=', row.id)
      .execute();

    return { grantID: row.id, scopes: parseScopes(row.scopes) };
  }

  refreshGrant(refresh: GrantRefresh): Promise<GrantRefreshOutcome> {
    return this.db.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom('grant_tokens')
        .innerJoin('grants', 'grants.id', 'grant_tokens.grant_id')
        .select(['grants.id', 'grants.scopes', 'grants.client_id', 'grants.resource'])
        .select(['grants.revoked_at', 'grant_tokens.expires_at', 'grant_tokens.used_at'])
        .where('grant_tokens.hash', '=', refresh.refreshHash)
        .where('grant_tokens.kind', '=', 'refresh')
        .executeTakeFirst();

      if (row === undefined || row.revoked_at !== null || row.expires_at <= refresh.now) {
        return { kind: 'invalid' };
      }

      if (row.client_id !== refresh.clientID || row.resource !== refresh.resource) {
        return { kind: 'invalid' };
      }

      const access: GrantAccess = { grantID: row.id, scopes: parseScopes(row.scopes) };

      if (row.used_at === null) {
        await trx
          .updateTable('grant_tokens')
          .set({ used_at: refresh.now })
          .where('hash', '=', refresh.refreshHash)
          .execute();

        await createTokenPair(
          trx,
          row.id,
          refresh.accessHash,
          refresh.nextRefreshHash,
          refresh.refreshHash,
          refresh,
        );

        return { kind: 'rotated', ...access };
      }

      const retried = await isRetriedRotation(trx, refresh, row.used_at);

      if (retried) {
        await trx
          .deleteFrom('grant_tokens')
          .where('parent_hash', '=', refresh.refreshHash)
          .execute();

        await createTokenPair(
          trx,
          row.id,
          refresh.accessHash,
          refresh.nextRefreshHash,
          refresh.refreshHash,
          refresh,
        );

        return { kind: 'rotated', ...access };
      }

      await revokeGrantIn(trx, row.id, refresh.now);

      return { kind: 'revoked' };
    });
  }

  revokeGrant(id: string, now: number): Promise<boolean> {
    return this.db.transaction().execute((trx) => revokeGrantIn(trx, id, now));
  }

  async collectGrants(): Promise<GrantSummary[]> {
    const rows = await this.db
      .selectFrom('grants')
      .selectAll()
      .where('revoked_at', 'is', null)
      .orderBy('created_at', 'asc')
      .execute();

    return rows.map((row) => ({
      id: row.id,
      clientID: row.client_id,
      clientName: row.client_name,
      scopes: parseScopes(row.scopes),
      resource: row.resource,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
    }));
  }

  // Drops expired tokens, grants with no live refresh token left along with
  // their remaining tokens, and clients registered more than clientGraceMs ago
  // that never gained a grant.
  async removeExpiredGrants(now: number, clientGraceMs: number): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await trx.deleteFrom('grant_tokens').where('expires_at', '<=', now).execute();

      await trx
        .deleteFrom('grants')
        .where((eb) => {
          const liveRefresh = eb
            .selectFrom('grant_tokens')
            .select('grant_tokens.hash')
            .whereRef('grant_tokens.grant_id', '=', 'grants.id')
            .where('grant_tokens.kind', '=', 'refresh');

          const hasLiveRefresh = eb.exists(liveRefresh);

          return eb.or([eb('revoked_at', 'is not', null), eb.not(hasLiveRefresh)]);
        })
        .execute();

      await trx
        .deleteFrom('grant_tokens')
        .where((eb) => {
          const owningGrant = eb
            .selectFrom('grants')
            .select('grants.id')
            .whereRef('grants.id', '=', 'grant_tokens.grant_id');

          return eb.not(eb.exists(owningGrant));
        })
        .execute();

      await trx
        .deleteFrom('oauth_clients')
        .where('created_at', '<=', now - clientGraceMs)
        .where((eb) => {
          const grantsOfClient = eb
            .selectFrom('grants')
            .select('grants.id')
            .whereRef('grants.client_id', '=', 'oauth_clients.client_id');

          return eb.not(eb.exists(grantsOfClient));
        })
        .execute();
    });
  }
}

async function createTokenPair(
  trx: Transaction<StateStoreSchema>,
  grantID: string,
  accessHash: string,
  refreshHash: string,
  parentHash: string | null,
  lifetimes: GrantLifetimes & { readonly now: number },
): Promise<void> {
  await trx
    .insertInto('grant_tokens')
    .values([
      {
        hash: accessHash,
        grant_id: grantID,
        kind: 'access',
        created_at: lifetimes.now,
        expires_at: lifetimes.now + lifetimes.accessMs,
        used_at: null,
        parent_hash: parentHash,
      },
      {
        hash: refreshHash,
        grant_id: grantID,
        kind: 'refresh',
        created_at: lifetimes.now,
        expires_at: lifetimes.now + lifetimes.refreshMs,
        used_at: null,
        parent_hash: parentHash,
      },
    ])
    .execute();
}

// A spent refresh token presented again inside the retry window, while the
// pair its rotation produced is still unused, means the client never received
// that pair; any other reuse means the token leaked.
async function isRetriedRotation(
  trx: Transaction<StateStoreSchema>,
  refresh: GrantRefresh,
  usedAt: number,
): Promise<boolean> {
  if (refresh.now - usedAt > refresh.retryWindowMs) {
    return false;
  }

  const successors = await trx
    .selectFrom('grant_tokens')
    .select(['used_at'])
    .where('parent_hash', '=', refresh.refreshHash)
    .execute();

  return successors.every((row) => row.used_at === null);
}

async function revokeGrantIn(
  trx: Transaction<StateStoreSchema>,
  id: string,
  now: number,
): Promise<boolean> {
  const result = await trx
    .updateTable('grants')
    .set({ revoked_at: now })
    .where('id', '=', id)
    .where('revoked_at', 'is', null)
    .executeTakeFirst();

  await trx.deleteFrom('grant_tokens').where('grant_id', '=', id).execute();

  return result.numUpdatedRows > 0n;
}

function parseScopes(stored: string): GrantScope[] {
  return GRANT_SCOPES.filter((scope) => stored.split(' ').includes(scope));
}

function parseURIList(stored: string): string[] {
  const parsed: unknown = JSON.parse(stored);

  return Array.isArray(parsed)
    ? parsed.filter((uri): uri is string => typeof uri === 'string')
    : [];
}
