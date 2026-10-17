import { getSettledValue } from '@atc/core';
import type { CredentialBroker } from '@atc/plugin-api';
import { BrokerAuthorityError } from './broker-authority-error';
import { verifyTokenImpAuthority } from './verify-token-imp-authority';

interface BrokerActivation {
  readonly impNames: readonly string[];
  readonly secrets: readonly string[];
  readonly oauthSecrets?: readonly string[];
}

// reads only, so a refusal leaves impd as it was; whether each secret's rules
// match the binding is a separate comparison
export async function verifyBrokerAuthority(
  broker: Pick<CredentialBroker, 'hostPrefix' | 'readFeatures' | 'readIdentity'>,
  activation: BrokerActivation,
): Promise<void> {
  const [featuresRead, identityRead] = await Promise.allSettled([
    broker.readFeatures(),
    broker.readIdentity(),
  ]);

  const features = getSettledValue(featuresRead);

  if (!features.grantableTokens || !features.secretRebind || !features.execRequire) {
    throw new BrokerAuthorityError(
      'auth_impd_too_old',
      'impd lacks grantable tokens, secret rebinds or exec requirements; it must be 0.30.0 or later',
      {
        grantableTokens: features.grantableTokens,
        secretRebind: features.secretRebind,
        execRequire: features.execRequire,
      },
    );
  }

  const oauthSecrets = activation.oauthSecrets ?? [];

  if (oauthSecrets.length > 0 && !features.oauthSecrets) {
    throw new BrokerAuthorityError(
      'auth_impd_too_old',
      `impd lacks oauth secret support, which ${oauthSecrets.join(', ')} needs`,
      { oauthSecrets: features.oauthSecrets, secrets: oauthSecrets },
    );
  }

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
