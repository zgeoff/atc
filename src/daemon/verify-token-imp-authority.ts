import { BrokerAuthorityError } from './broker-authority-error';
import type { ImpIdentity } from './imp-port';
import { isImpNameAllowed } from './is-imp-name-allowed';

/**
 * Rejects unless the token may manage every named imp and no other imp
 * beyond its own patterns: scope `manage`, imp patterns rather than none,
 * no pattern of `*` alone, and each name within a pattern. A token that
 * reaches every imp on the host is refused outright, never used in place
 * of a limited one. The names are the imps the call touches, as the
 * target's runtime namespace builds them.
 */
export function verifyTokenImpAuthority(identity: ImpIdentity, impNames: readonly string[]): void {
  if (identity.scope !== 'manage') {
    throw new BrokerAuthorityError(
      'auth_token_scope',
      `impd token ${identity.name} cannot manage imps`,
      {
        token: identity.name,
        scope: identity.scope,
      },
    );
  }

  const patterns = identity.imps;

  if (patterns === null || patterns.some((pattern) => isUnrestrictedPattern(pattern))) {
    throw new BrokerAuthorityError(
      'auth_token_too_broad',
      `impd token ${identity.name} reaches every imp on the host`,
      { token: identity.name, imps: patterns },
    );
  }

  const outside = impNames.filter((name) => !isImpNameAllowed(patterns, name));

  if (outside.length > 0) {
    throw new BrokerAuthorityError(
      'auth_imp_out_of_scope',
      `impd token ${identity.name} cannot manage ${outside.join(', ')}`,
      { token: identity.name, imps: patterns, outside },
    );
  }
}

// A pattern of `*` alone, however many, matches every imp name.
function isUnrestrictedPattern(pattern: string): boolean {
  return pattern.replaceAll('*', '') === '';
}
