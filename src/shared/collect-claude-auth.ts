import type { AuthProfile } from './collect-auth-profiles';
import { isRecord } from './report';
import { resolveAuthProfiles } from './resolve-auth-profiles';

/**
 * The profiles a stock Claude session on a target that reaches impd's
 * broker signs in through: one of them sends the subscription's setup
 * token to the Anthropic API as a bearer authorization header, and the
 * rest bind beside it, such as a GitHub token.
 */
export interface ClaudeAuth {
  readonly profiles: readonly string[];
}

interface CollectedClaudeAuth {
  readonly auth: ClaudeAuth | null;
  readonly errors: readonly string[];
}

/**
 * Reads the `claudeAuth` entry against the auth profiles. An entry that
 * does not resolve, or whose profiles send no bearer authorization header
 * to the Anthropic API, is left out with every problem that refused it, so
 * stock Claude keeps the sign-in of the host it runs on rather than binding
 * a credential the CLI would never send.
 */
export function collectClaudeAuth(
  raw: unknown,
  authProfiles: ReadonlyMap<string, AuthProfile>,
): CollectedClaudeAuth {
  if (raw === undefined) {
    return { auth: null, errors: [] };
  }

  const profiles = isRecord(raw) ? raw['profiles'] : undefined;

  if (
    !isRecord(raw) ||
    !Array.isArray(profiles) ||
    profiles.length === 0 ||
    !profiles.every((name) => typeof name === 'string')
  ) {
    return {
      auth: null,
      errors: ['claudeAuth must be an object with a non-empty profiles array'],
    };
  }

  const extra = Object.keys(raw).find((key) => key !== 'profiles');

  if (extra !== undefined) {
    return {
      auth: null,
      errors: [
        `claudeAuth.${extra} cannot be set: atc fixes the endpoint and the placeholder of a Claude subscription session`,
      ],
    };
  }

  const selected = profiles.map(String);
  const resolution = resolveAuthProfiles(authProfiles, selected);

  if ('problem' in resolution) {
    return { auth: null, errors: [`claudeAuth: ${resolution.problem.message}`] };
  }

  const rule = resolution.resolved.secrets
    .flatMap((secret) => secret.rules)
    .find((r) => r.host === ANTHROPIC_API_HOST);

  if (rule?.header !== 'authorization' || rule.scheme !== 'bearer') {
    return {
      auth: null,
      errors: [
        `claudeAuth needs a profile that sets a bearer authorization header for ${ANTHROPIC_API_HOST}, where Claude Code sends its subscription token`,
      ],
    };
  }

  return { auth: { profiles: selected }, errors: [] };
}

// The one host Claude Code sends a subscription token to.
const ANTHROPIC_API_HOST = 'api.anthropic.com';
