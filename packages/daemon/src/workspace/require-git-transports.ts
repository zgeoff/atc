import type { InvalidGitTransports } from '@atc/config';
import { AtcError } from '@atcx/contract/light';

export function requireGitTransports(
  policy: readonly string[] | InvalidGitTransports,
  data?: Readonly<Record<string, unknown>>,
): readonly string[] {
  if ('invalid' in policy) {
    throw new AtcError(
      'git_transports_invalid',
      `workspaces.gitTransports in config.json is invalid, so the daemon runs no git: ${policy.invalid}`,
      data,
    );
  }

  return policy;
}
