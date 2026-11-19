import { resolveAuthProfiles } from '@atc/config';
import type { AuthProfileProblem, ResolvedAuthSecret } from '@atc/config';
import type { AgentID } from '@atc/core';
import type { AuthProfile, GatewayAuth } from '@atc/plugin-api';
import { buildBindingHash } from './build-binding-hash';

export interface AuthBinding {
  readonly agent: AgentID;
  readonly baseURL: string;
  readonly profiles: readonly string[];
  readonly secrets: readonly ResolvedAuthSecret[];
  readonly placeholderEnv: Readonly<Record<string, string>>;
  readonly profileEnv: Readonly<Record<string, string>>;

  readonly telemetryHost: string | null;
  readonly hash: string;
}

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
  const telemetryHost = resolution.resolved.telemetry?.host ?? null;

  return {
    binding: {
      agent: gateway.id,
      baseURL: gateway.baseURL,
      profiles: resolution.resolved.profiles,
      secrets,
      placeholderEnv: gateway.auth.placeholderEnv,
      profileEnv,
      telemetryHost,
      hash: buildBindingHash({ secrets, profileEnv, telemetryHost }),
    },
  };
}
