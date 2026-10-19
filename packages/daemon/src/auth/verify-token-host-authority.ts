import type { BrokerIdentity } from '@atc/plugin-api';
import { isHostNameAllowed } from '@atc/plugin-api';
import { BrokerAuthorityError } from './broker-authority-error';

export function verifyTokenHostAuthority(
  identity: BrokerIdentity,
  hostNames: readonly string[],
  hostPrefix: string,
): void {
  assertHostPrefix(hostPrefix);

  if (identity.scope !== 'manage') {
    throw new BrokerAuthorityError(
      'auth_token_scope',
      `broker token ${identity.name} cannot manage hosts`,
      {
        token: identity.name,
        scope: identity.scope,
      },
    );
  }

  const patterns = identity.hosts;

  // any pattern beyond the prefix refuses the token outright, however few names
  // it reaches; a contained pattern never stands in for it
  if (patterns === null || !patterns.every((pattern) => isPatternContained(pattern, hostPrefix))) {
    throw new BrokerAuthorityError(
      'auth_token_too_broad',
      `broker token ${identity.name} can reach hosts outside atc's namespace, whose host names start with ${hostPrefix}`,
      {
        token: identity.name,
        hosts: patterns,
        offending:
          patterns === null
            ? null
            : patterns.filter((pattern) => !isPatternContained(pattern, hostPrefix)),
      },
    );
  }

  const outside = hostNames.filter((name) => !isHostNameAllowed(patterns, name));

  if (outside.length > 0) {
    throw new BrokerAuthorityError(
      'auth_host_out_of_scope',
      `broker token ${identity.name} cannot manage ${outside.join(', ')}`,
      { token: identity.name, hosts: patterns, outside },
    );
  }
}

// An empty prefix would contain every pattern, `*` included.
function assertHostPrefix(hostPrefix: string): void {
  if (hostPrefix === '') {
    throw new Error('the host name prefix of a runtime namespace must not be empty');
  }
}

// Every name a pattern matches starts with the text before its first `*`.
function isPatternContained(pattern: string, hostPrefix: string): boolean {
  const [literal = ''] = pattern.split('*');

  return literal.startsWith(hostPrefix);
}
