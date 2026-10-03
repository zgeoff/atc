import { BrokerAuthorityError } from './broker-authority-error';
import type { ImpIdentity } from './imp-port';
import { isImpNameAllowed } from './is-imp-name-allowed';

/**
 * Rejects unless the token may manage every named imp and reaches no imp
 * outside atc's namespace: scope `manage`, imp patterns rather than none,
 * and each pattern contained in the namespace prefix, so the literal text
 * before its first `*`, or the whole pattern when it has none, starts with
 * the prefix. A token with any pattern beyond the prefix is refused
 * outright, however few names that pattern reaches, never used in place of
 * a contained one. Each name must then match a pattern. The prefix is the
 * literal start of every imp name the target's runtime namespace builds,
 * and the names are the imps the call touches under those built names.
 */
export function verifyTokenImpAuthority(
  identity: ImpIdentity,
  impNames: readonly string[],
  impPrefix: string,
): void {
  assertImpPrefix(impPrefix);

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

  if (patterns === null || !patterns.every((pattern) => isPatternContained(pattern, impPrefix))) {
    throw new BrokerAuthorityError(
      'auth_token_too_broad',
      `impd token ${identity.name} can reach imps outside atc's namespace, whose imp names start with ${impPrefix}`,
      {
        token: identity.name,
        imps: patterns,
        offending:
          patterns === null
            ? null
            : patterns.filter((pattern) => !isPatternContained(pattern, impPrefix)),
      },
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

// An empty prefix would contain every pattern, `*` included.
function assertImpPrefix(impPrefix: string): void {
  if (impPrefix === '') {
    throw new Error('the imp name prefix of a runtime namespace must not be empty');
  }
}

// Every name a pattern matches starts with the text before its first `*`.
function isPatternContained(pattern: string, impPrefix: string): boolean {
  const [literal = ''] = pattern.split('*');

  return literal.startsWith(impPrefix);
}
