import type { CredentialBroker, GuestOAuthState } from '@atc/plugin-api';
import { CredentialBrokerError } from '@atc/plugin-api';
import { DaemonError } from '@atc/protocol/wire';
import type { AuthBinding } from './build-auth-binding';
import { collectSecretRuleMismatches } from './collect-secret-rule-mismatches';

export async function loadOAuthStates(
  host: CredentialBroker,
  binding: AuthBinding,
): Promise<Readonly<Record<string, GuestOAuthState>> | undefined> {
  const expected = binding.secrets.filter((secret) => secret.kind === 'oauth');

  if (expected.length === 0) {
    return undefined;
  }

  try {
    await host.verifyVersion();

    const held = await host.readSecrets();

    const mismatches = collectSecretRuleMismatches(expected, held);

    if (mismatches.length > 0) {
      throw new DaemonError(
        'auth_secret_mismatch',
        `the broker holds ${mismatches.map((mismatch) => `${mismatch.secret} (${mismatch.reason})`).join(', ')} unlike the binding`,
        { mismatches },
      );
    }

    return Object.fromEntries(
      held.flatMap((secret) =>
        secret.oauth !== undefined && expected.some((want) => want.secret === secret.name)
          ? [[secret.name, { status: secret.oauth.status, idClaims: secret.oauth.idClaims }]]
          : [],
      ),
    );
  } catch (error) {
    if (error instanceof CredentialBrokerError) {
      throw new DaemonError(
        'host_unavailable',
        `the ${error.provider} credential broker refused a runtime auth call: ${error.message}`,
        { provider: error.provider, problem: error.brokerCode.toLowerCase() },
      );
    }

    throw error;
  }
}
