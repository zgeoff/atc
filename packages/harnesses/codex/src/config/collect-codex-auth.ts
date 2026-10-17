import { resolveAuthProfiles } from '@atc/config';
import { isRecord } from '@atc/core';
import type { AuthProfile } from '@atc/plugin-api';

interface CollectedCodexAuth {
  readonly profiles: readonly string[] | null;
  readonly errors: readonly string[];
}

// one profile must send an `oauth` secret to `chatgpt.com` as a bearer authorization header,
// where codex sends its chatgpt sign-in; the rest bind beside it, such as a github token
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

  const secret = resolution.resolved.secrets.find((s) =>
    s.rules.some((rule) => rule.host === CHATGPT_HOST),
  );

  const rule = secret?.rules.find((r) => r.host === CHATGPT_HOST);

  if (secret?.kind !== 'oauth' || rule?.header !== 'authorization' || rule.scheme !== 'bearer') {
    return {
      profiles: null,
      errors: [
        `auth needs an oauth profile that sets a bearer authorization header for ${CHATGPT_HOST}, where Codex sends its ChatGPT sign-in`,
      ],
    };
  }

  return { profiles: selected, errors: [] };
}

// The one host Codex sends its ChatGPT sign-in to.
const CHATGPT_HOST = 'chatgpt.com';
