import type { GrantScope } from '@atcx/contract';
import type { PTYRefusalOutcome } from './pick-pty-admission';

type PTYPrincipal =
  | { readonly kind: 'principal'; readonly principal: string | null }
  | {
      readonly kind: 'refuse';
      readonly status: 401 | 403;
      readonly outcome: PTYRefusalOutcome | null;
    };

interface PTYTokenCheck {
  readonly isOwnerToken: boolean;

  readonly access: { readonly clientID: string; readonly scopes: readonly GrantScope[] } | null;
}

export function pickPTYPrincipal(check: PTYTokenCheck): PTYPrincipal {
  if (check.isOwnerToken) {
    return { kind: 'principal', principal: null };
  }

  if (check.access === null) {
    return { kind: 'refuse', status: 401, outcome: { kind: 'bearer', reason: 'invalid_token' } };
  }

  return check.access.scopes.includes('read')
    ? { kind: 'principal', principal: check.access.clientID }
    : { kind: 'refuse', status: 403, outcome: null };
}
