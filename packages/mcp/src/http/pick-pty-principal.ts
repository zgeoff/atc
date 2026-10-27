import type { VerifiedAccess } from '../auth/types';

// The principal a token watches as, where null is the daemon's owner.
type PTYPrincipal =
  | { readonly kind: 'principal'; readonly principal: string | null }
  | { readonly kind: 'refused' }
  | { readonly kind: 'no_read' };

interface PTYTokenCheck {
  // Whether the token is one from the owner's token file.
  readonly isOwnerToken: boolean;

  // The OAuth access the token verified to, null when it verified to none.
  readonly access: VerifiedAccess | null;
}

// An OAuth access token needs the read scope to watch.
export function pickPTYPrincipal(check: PTYTokenCheck): PTYPrincipal {
  if (check.isOwnerToken) {
    return { kind: 'principal', principal: null };
  }

  if (check.access === null) {
    return { kind: 'refused' };
  }

  return check.access.scopes.includes('read')
    ? { kind: 'principal', principal: check.access.clientID }
    : { kind: 'no_read' };
}
