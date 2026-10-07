import { createHash } from 'node:crypto';
import type { AgentID } from '../shared/agent-id';
import type { GatewayAuth } from '../shared/check-gateway-auth';
import type { AuthProfile } from '../shared/collect-auth-profiles';
import type { GatewayConfig } from '../shared/collect-gateways';
import { resolveAuthProfiles } from '../shared/resolve-auth-profiles';
import type { AuthProfileProblem, ResolvedAuthSecret } from '../shared/resolve-auth-profiles';
import { sortJSONKeys } from '../shared/sort-json-keys';

/**
 * What a session's runtime is bound to through impd's broker: every
 * profile its gateway's selection reaches, the secrets they need impd to
 * hold with exactly these rules, the placeholder variables in place of a
 * credential, the variables the profiles set, and the endpoint. `hash`
 * covers the secrets and their rules, and the profile variables when there
 * are any, so a change to a profile the binding does not reach leaves it as
 * it was, and a change to one it reaches gives another hash.
 */
export interface AuthBinding {
  readonly agent: AgentID;
  readonly baseURL: string;
  readonly profiles: readonly string[];
  readonly secrets: readonly ResolvedAuthSecret[];
  readonly placeholderEnv: Readonly<Record<string, string>>;
  readonly profileEnv: Readonly<Record<string, string>>;
  readonly hash: string;
}

type AuthGateway = Pick<GatewayConfig, 'id' | 'baseURL'> & { readonly auth: GatewayAuth };

/**
 * Plans the binding a gateway's auth asks for against the current auth
 * profiles, or the problem that refuses it. The hash is the SHA-256 of the
 * resolved secrets (and profile variables, when set) as canonical JSON, with each list sorted, so the order
 * of the selection or of the config never changes it.
 */
export function buildAuthBinding(
  gateway: AuthGateway,
  profiles: ReadonlyMap<string, AuthProfile>,
): { readonly binding: AuthBinding } | { readonly problem: AuthProfileProblem } {
  const resolution = resolveAuthProfiles(profiles, gateway.auth.profiles);

  if ('problem' in resolution) {
    return resolution;
  }

  const secrets = resolution.resolved.secrets;
  const profileEnv = resolution.resolved.env;
  const hashed = Object.keys(profileEnv).length === 0 ? { secrets } : { secrets, profileEnv };

  return {
    binding: {
      agent: gateway.id,
      baseURL: gateway.baseURL,
      profiles: resolution.resolved.profiles,
      secrets,
      placeholderEnv: gateway.auth.placeholderEnv,
      profileEnv,
      hash: createHash('sha256')
        .update(JSON.stringify(sortJSONKeys(hashed)))
        .digest('hex'),
    },
  };
}
