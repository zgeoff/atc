import { resolveAuthProfiles } from '@atc/config';
import { isRecord } from '@atc/core';
import type { AuthProfile } from '@atc/plugin-api';

type CollectedCodexAuth =
  | {
      readonly profiles: readonly string[];
      readonly envOwners: Readonly<Record<string, string>>;
      readonly telemetry: { readonly profile: string; readonly host: string } | null;
      readonly errors: readonly [];
    }
  | { readonly profiles: null; readonly errors: readonly string[] };

// Codex sends its ChatGPT sign-in only to this host.
const CHATGPT_HOST = 'chatgpt.com';

export function collectCodexAuth(
  raw: unknown,
  authProfiles: ReadonlyMap<string, AuthProfile>,
): CollectedCodexAuth {
  const profiles = isRecord(raw) ? raw['profiles'] : undefined;

  if (
    !isRecord(raw) ||
    !Array.isArray(profiles) ||
    profiles.length === 0 ||
    !profiles.every((name) => typeof name === 'string')
  ) {
    return { profiles: null, errors: ['auth must be an object with a non-empty profiles array'] };
  }

  const extra = Object.keys(raw).find((key) => key !== 'profiles');

  if (extra !== undefined) {
    return {
      profiles: null,
      errors: [
        `auth.${extra} cannot be set: atc fixes the endpoint and the sign-in of a Codex session`,
      ],
    };
  }

  const selected = profiles.map(String);
  const resolution = resolveAuthProfiles(authProfiles, selected);

  if ('problem' in resolution) {
    return { profiles: null, errors: [`auth: ${resolution.problem.message}`] };
  }

  const secret = resolution.resolved.secrets.find((candidate) =>
    candidate.rules.some((rule) => rule.host === CHATGPT_HOST),
  );

  const rule = secret?.rules.find((candidate) => candidate.host === CHATGPT_HOST);

  if (secret?.kind !== 'oauth' || rule?.header !== 'authorization' || rule.scheme !== 'bearer') {
    return {
      profiles: null,
      errors: [
        `auth needs an oauth profile that sets a bearer authorization header for ${CHATGPT_HOST}, where Codex sends its ChatGPT sign-in`,
      ],
    };
  }

  return {
    profiles: selected,
    envOwners: resolution.resolved.envOwners,
    telemetry: resolution.resolved.telemetry,
    errors: [],
  };
}
