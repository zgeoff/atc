import type { GuestOAuthState } from '../agents/agent-adapter';
import { DaemonError } from '../protocol/daemon-error';
import type { BrokerAuthHost } from './broker-auth-host';
import type { AuthBinding } from './build-auth-binding';
import { collectSecretRuleMismatches } from './collect-secret-rule-mismatches';
import { ImpPortError } from './imp-port-error';

/**
 * The sign-in state impd lists for each secret a binding holds as kind
 * `oauth`, keyed by the secret's name, or undefined for a binding that
 * holds none, which reads nothing from impd. It reads impd's features and
 * then its secrets once, and refuses an impd without oauth secrets, and a
 * bound oauth secret that impd lacks or holds with another kind or rules,
 * with the codes the binding's own gate would give.
 */
export async function loadOAuthStates(
  host: BrokerAuthHost,
  binding: AuthBinding,
): Promise<Readonly<Record<string, GuestOAuthState>> | undefined> {
  const expected = binding.secrets.filter((secret) => secret.kind === 'oauth');

  if (expected.length === 0) {
    return undefined;
  }

  try {
    const features = await host.port.readFeatures();

    if (!features.oauthSecrets) {
      throw new DaemonError(
        'auth_impd_too_old',
        `impd lacks oauth secret support, which ${expected.map((secret) => secret.secret).join(', ')} needs`,
        { oauthSecrets: false, secrets: expected.map((secret) => secret.secret) },
      );
    }

    const held = await host.port.readSecrets();

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
    if (error instanceof ImpPortError) {
      throw new DaemonError(
        'host_unavailable',
        `impd refused a runtime auth call: ${error.message}`,
        { provider: 'imp', problem: error.code.toLowerCase() },
      );
    }

    throw error;
  }
}
