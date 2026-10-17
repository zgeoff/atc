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
    const features = await host.readFeatures();

    if (!features.oauthSecrets) {
      throw new DaemonError(
        'auth_impd_too_old',
        `impd lacks oauth secret support, which ${expected.map((secret) => secret.secret).join(', ')} needs`,
        { oauthSecrets: false, secrets: expected.map((secret) => secret.secret) },
      );
    }

    const held = await host.readSecrets();

    const mismatches = collectSecretRuleMismatches(expected, held);

    if (mismatches.length > 0) {
      throw new DaemonError(
        'auth_secret_mismatch',
        `impd holds ${mismatches.map((mismatch) => `${mismatch.secret} (${mismatch.reason})`).join(', ')} unlike the binding`,
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
        `impd refused a runtime auth call: ${error.message}`,
        { provider: 'imp', problem: error.brokerCode.toLowerCase() },
      );
    }

    throw error;
  }
}
