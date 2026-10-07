import type { AuthProfile } from './collect-auth-profiles';
import { isRecord } from './report';
import { resolveAuthProfiles } from './resolve-auth-profiles';

interface CollectedCodexAuth {
  readonly profiles: readonly string[] | null;
  readonly errors: readonly string[];
}

/**
 * Reads the `auth` of a Codex entry against the auth profiles: the
 * profiles a Codex session on a target that reaches impd's broker signs in
 * through. One of them must send an `oauth` secret to `chatgpt.com` as a
 * bearer authorization header, where Codex sends its ChatGPT sign-in, and
 * the rest bind beside it, such as a GitHub token. An entry that does not
 * resolve or holds no such profile gets null and every problem with it.
 */
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
