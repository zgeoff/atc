import { BrokerAuthorityError } from './broker-authority-error';
import type { ImpPort } from './imp-port';
import { verifyTokenImpAuthority } from './verify-token-imp-authority';

/**
 * What a provisioning call is about to touch: the imps under their actual
 * names, as the target's runtime namespace builds them, and every secret
 * the binding grants them.
 */
export interface BrokerActivation {
  readonly impNames: readonly string[];
  readonly secrets: readonly string[];
}

/**
 * The gate before atc grants or relies on a brokered credential. It reads
 * impd's features, then the token's identity, and writes nothing, so a
 * refusal leaves impd as it was. It rejects unless impd has both grantable
 * tokens and secret rebinds, the token may manage each imp and reaches no
 * imp beyond its own patterns, and the token may grant every bound secret.
 * Whether each secret's rules match the binding is a separate comparison.
 */
export async function verifyBrokerAuthority(
  port: Pick<ImpPort, 'readFeatures' | 'readIdentity'>,
  activation: BrokerActivation,
): Promise<void> {
  const features = await port.readFeatures();

  if (!features.grantableTokens || !features.secretRebind) {
    throw new BrokerAuthorityError(
      'auth_impd_too_old',
      'impd lacks grantable tokens or secret rebinds; it must be 0.27.0 or later',
      { grantableTokens: features.grantableTokens, secretRebind: features.secretRebind },
    );
  }

  const identity = await port.readIdentity();

  verifyTokenImpAuthority(identity, activation.impNames);

  const missing = activation.secrets.filter((secret) => !identity.grantable.includes(secret));

  if (missing.length > 0) {
    throw new BrokerAuthorityError(
      'auth_secret_not_grantable',
      `impd token ${identity.name} cannot grant ${missing.join(', ')}`,
      { token: identity.name, grantable: identity.grantable, missing },
    );
  }
}
