import type { BrokerIdentity } from '@atc/plugin-api';
import { isHostNameAllowed } from '@atc/plugin-api';
import { BrokerAuthorityError } from './broker-authority-error';

export function verifyTokenImpAuthority(
  identity: BrokerIdentity,
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

  const patterns = identity.hosts;

  // any pattern beyond the prefix refuses the token outright, however few names
  // it reaches; a contained pattern never stands in for it
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

  const outside = impNames.filter((name) => !isHostNameAllowed(patterns, name));

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
