import { match } from 'ts-pattern';
import { parseRequestParams } from '../protocol/parse-request-params';
import type { ErrorCode } from '../protocol/protocol';
import type { GrantStore } from '../store/grant-store';
import { mintClientID } from './mint-client-id';
import { mintGrantID } from './mint-grant-id';

const GRANT_METHODS = [
  'grant.create',
  'grant.verify',
  'grant.refresh',
  'grant.list',
  'grant.revoke',
  'grant.registerClient',
  'grant.findClient',
] as const;

export type GrantMethod = (typeof GRANT_METHODS)[number];

/**
 * How long each credential lives, in milliseconds.
 */
export interface GrantPolicy {
  readonly accessMs: number;
  readonly refreshMs: number;

  // How long after a refresh the spent refresh token still counts as a retry.
  readonly retryWindowMs: number;

  // How long a registered client may wait for its first grant before it is pruned.
  readonly clientGraceMs: number;
}

export interface GrantDesk {
  readonly store: GrantStore;
  readonly policy: GrantPolicy;
  readonly now: () => number;
}

export type GrantAnswer =
  | { readonly ok: Readonly<Record<string, unknown>> }
  | { readonly err: { readonly code: ErrorCode; readonly msg: string } };

export function isGrantMethod(method: string): method is GrantMethod {
  return GRANT_METHODS.some((m) => m === method);
}

/**
 * Answers one `grant.*` request against the grant store. Only hashes of
 * tokens cross the socket, and no answer ever carries one back.
 */
export function answerGrantRequest(
  method: GrantMethod,
  rawParams: unknown,
  desk: GrantDesk,
): Promise<GrantAnswer> {
  return match(method)
    .with('grant.create', () => answerCreate(rawParams, desk))
    .with('grant.verify', () => answerVerify(rawParams, desk))
    .with('grant.refresh', () => answerRefresh(rawParams, desk))
    .with('grant.list', () => answerList(desk))
    .with('grant.revoke', () => answerRevoke(rawParams, desk))
    .with('grant.registerClient', () => answerRegisterClient(rawParams, desk))
    .with('grant.findClient', () => answerFindClient(rawParams, desk))
    .exhaustive();
}

async function answerCreate(rawParams: unknown, desk: GrantDesk): Promise<GrantAnswer> {
  const parsed = parseRequestParams('grant.create', rawParams);

  if (!parsed.ok) {
    return buildBadArgs(parsed.message);
  }

  const now = desk.now();
  const id = mintGrantID();

  await desk.store.createGrant({
    ...parsed.data,
    id,
    now,
    accessMs: desk.policy.accessMs,
    refreshMs: desk.policy.refreshMs,
  });

  // Pruned only once the grant exists, so a registered client past its grace
  // is kept by the grant it just gained instead of removed right before it.
  await desk.store.removeExpiredGrants(now, desk.policy.clientGraceMs);

  return { ok: { grant: id, expiresIn: Math.floor(desk.policy.accessMs / 1000) } };
}

async function answerVerify(rawParams: unknown, desk: GrantDesk): Promise<GrantAnswer> {
  const parsed = parseRequestParams('grant.verify', rawParams);

  if (!parsed.ok) {
    return buildBadArgs(parsed.message);
  }

  const access = await desk.store.verifyAccessToken(
    parsed.data.accessHash,
    parsed.data.resource,
    desk.now(),
  );

  if (access === null) {
    return { err: { code: 'unauthorized', msg: 'the access token is not valid' } };
  }

  return { ok: { grant: access.grantID, clientName: access.clientName, scopes: access.scopes } };
}

async function answerRefresh(rawParams: unknown, desk: GrantDesk): Promise<GrantAnswer> {
  const parsed = parseRequestParams('grant.refresh', rawParams);

  if (!parsed.ok) {
    return buildBadArgs(parsed.message);
  }

  const outcome = await desk.store.refreshGrant({
    ...parsed.data,
    now: desk.now(),
    accessMs: desk.policy.accessMs,
    refreshMs: desk.policy.refreshMs,
    retryWindowMs: desk.policy.retryWindowMs,
  });

  return match(outcome)
    .with({ kind: 'rotated' }, (rotated) => ({
      ok: {
        grant: rotated.grantID,
        scopes: rotated.scopes,
        expiresIn: Math.floor(desk.policy.accessMs / 1000),
      },
    }))
    .with({ kind: 'revoked' }, () => ({
      err: {
        code: 'unauthorized' as const,
        msg: 'the refresh token was reused, so its grant is revoked',
      },
    }))
    .with({ kind: 'invalid' }, () => ({
      err: { code: 'unauthorized' as const, msg: 'the refresh token is not valid' },
    }))
    .exhaustive();
}

async function answerList(desk: GrantDesk): Promise<GrantAnswer> {
  await desk.store.removeExpiredGrants(desk.now(), desk.policy.clientGraceMs);

  const grants = await desk.store.collectGrants();

  return { ok: { grants } };
}

async function answerRevoke(rawParams: unknown, desk: GrantDesk): Promise<GrantAnswer> {
  const parsed = parseRequestParams('grant.revoke', rawParams);

  if (!parsed.ok) {
    return buildBadArgs(parsed.message);
  }

  const revoked = await desk.store.revokeGrant(parsed.data.grant, desk.now());

  if (!revoked) {
    return buildBadArgs(`no grant '${parsed.data.grant}'`);
  }

  return { ok: {} };
}

// Registration is unauthenticated, so the clients it can leave behind before
// any of them gains a grant are capped.
const MAX_CLIENTS_WITHOUT_GRANT = 100;

async function answerRegisterClient(rawParams: unknown, desk: GrantDesk): Promise<GrantAnswer> {
  const parsed = parseRequestParams('grant.registerClient', rawParams);

  if (!parsed.ok) {
    return buildBadArgs(parsed.message);
  }

  const now = desk.now();

  await desk.store.removeExpiredGrants(now, desk.policy.clientGraceMs);

  const clientID = mintClientID();

  const created = await desk.store.tryCreateClient(
    { clientID, name: parsed.data.name, redirectURIs: parsed.data.redirectURIs },
    now,
    MAX_CLIENTS_WITHOUT_GRANT,
  );

  if (!created) {
    return {
      err: {
        code: 'at_capacity',
        msg: `${MAX_CLIENTS_WITHOUT_GRANT} registered clients are still waiting for a grant`,
      },
    };
  }

  return { ok: { clientID } };
}

async function answerFindClient(rawParams: unknown, desk: GrantDesk): Promise<GrantAnswer> {
  const parsed = parseRequestParams('grant.findClient', rawParams);

  if (!parsed.ok) {
    return buildBadArgs(parsed.message);
  }

  const client = await desk.store.findClient(parsed.data.clientID);

  return { ok: { client } };
}

function buildBadArgs(msg: string): GrantAnswer {
  return { err: { code: 'bad_args', msg } };
}
