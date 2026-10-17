import { createHash } from 'node:crypto';
import { resolveAuthProfiles } from '@atc/config';
import type { AuthProfileProblem, ResolvedAuthSecret } from '@atc/config';
import type { AgentID } from '@atc/core';
import { sortJSONKeys } from '@atc/core';
import type { AuthProfile, GatewayAuth } from '@atc/plugin-api';

export interface AuthBinding {
  readonly agent: AgentID;
  readonly baseURL: string;
  readonly profiles: readonly string[];
  readonly secrets: readonly ResolvedAuthSecret[];
  readonly placeholderEnv: Readonly<Record<string, string>>;
  readonly profileEnv: Readonly<Record<string, string>>;
  readonly hash: string;
}

// The parts of a gateway entry a binding reads: its agent id, its endpoint,
// and the auth it asks for.
interface AuthGateway {
  readonly id: AgentID;
  readonly baseURL: string;
  readonly auth: GatewayAuth;
}

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
        .update(JSON.stringify(sortJSONKeys(hashed, 'locale')))
        .digest('hex'),
    },
  };
}
