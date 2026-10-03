import { DaemonError } from '../protocol/daemon-error';
import type { InvalidGitTransports } from '../shared/collect-workspaces-config';

/**
 * The transports git may fetch over, or the refusal of a git operation
 * when the configured list is invalid: the daemon then runs no git at all,
 * and the error quotes the config errors it printed at startup, with
 * `data` as its detail.
 */
export function requireGitTransports(
  policy: readonly string[] | InvalidGitTransports,
  data?: Readonly<Record<string, unknown>>,
): readonly string[] {
  if ('invalid' in policy) {
    throw new DaemonError(
      'git_transports_invalid',
      `workspaces.gitTransports in config.json is invalid, so the daemon runs no git: ${policy.invalid}`,
      data,
    );
  }

  return policy;
}
