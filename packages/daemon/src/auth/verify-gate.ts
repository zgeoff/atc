import { getSettledValue } from '@atc/core';
import type { CredentialBroker } from '@atc/plugin-api';
import { DaemonError } from '@atc/protocol/wire';
import type { AuthBinding } from './build-auth-binding';
import { collectSecretRuleMismatches } from './collect-secret-rule-mismatches';
import { verifyBrokerAuthority } from './verify-broker-authority';

// The full gate on a binding: impd's version and the token's authority
// over the imp and every bound secret, then each secret's kind and rules.
// The secrets are read with the authority's reads and checked after them.
export async function verifyGate(
  host: CredentialBroker,
  impName: string,
  binding: AuthBinding,
): Promise<void> {
  const secrets = binding.secrets.map((secret) => secret.secret);

  const [authority, secretsRead] = await Promise.allSettled([
    verifyBrokerAuthority(host, { impNames: [impName], secrets }),
    host.readSecrets(),
  ]);

  getSettledValue(authority);

  const held = getSettledValue(secretsRead);
  const mismatches = collectSecretRuleMismatches(binding.secrets, held);

  if (mismatches.length > 0) {
    throw new DaemonError(
      'auth_secret_mismatch',
      `impd holds ${mismatches.map((mismatch) => `${mismatch.secret} (${mismatch.reason})`).join(', ')} unlike the binding`,
      { mismatches },
    );
  }
}
