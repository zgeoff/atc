import { getSettledValue } from '@atc/core';
import type { CredentialBroker } from '@atc/plugin-api';
import { BrokerAuthorityError } from './broker-authority-error';
import { verifyTokenImpAuthority } from './verify-token-imp-authority';

interface BrokerActivation {
  readonly impNames: readonly string[];
  readonly secrets: readonly string[];
}

// reads only, so a refusal leaves impd as it was; whether each secret's rules
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

  verifyTokenImpAuthority(identity, activation.impNames, broker.hostPrefix);

  const missing = activation.secrets.filter((secret) => !identity.grantable.includes(secret));

  if (missing.length > 0) {
    throw new BrokerAuthorityError(
      'auth_secret_not_grantable',
      `impd token ${identity.name} cannot grant ${missing.join(', ')}`,
      { token: identity.name, grantable: identity.grantable, missing },
    );
  }
}
