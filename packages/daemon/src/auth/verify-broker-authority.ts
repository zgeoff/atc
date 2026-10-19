import { getSettledValue } from '@atc/core';
import type { CredentialBroker } from '@atc/plugin-api';
import { BrokerAuthorityError } from './broker-authority-error';
import { verifyTokenHostAuthority } from './verify-token-host-authority';

interface BrokerActivation {
  readonly hostNames: readonly string[];
  readonly secrets: readonly string[];
}

// reads only, so a refusal leaves the broker as it was; whether each secret's rules
// match the binding is a separate comparison
export async function verifyBrokerAuthority(
  broker: Pick<CredentialBroker, 'hostPrefix' | 'verifyVersion' | 'readIdentity'>,
  activation: BrokerActivation,
): Promise<void> {
  const [versionCheck, identityRead] = await Promise.allSettled([
    broker.verifyVersion(),
    broker.readIdentity(),
  ]);

  getSettledValue(versionCheck);

  const identity = getSettledValue(identityRead);

  verifyTokenHostAuthority(identity, activation.hostNames, broker.hostPrefix);

  const missing = activation.secrets.filter((secret) => !identity.grantable.includes(secret));

  if (missing.length > 0) {
    throw new BrokerAuthorityError(
      'auth_secret_not_grantable',
      `broker token ${identity.name} cannot grant ${missing.join(', ')}`,
      { token: identity.name, grantable: identity.grantable, missing },
    );
  }
}
