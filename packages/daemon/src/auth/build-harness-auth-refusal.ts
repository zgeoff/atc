import { DaemonError } from '@atc/protocol/wire';
import { match } from 'ts-pattern';
import type { HarnessAuthRefusal } from './decide-harness-auth';

// The refusal of a launch whose agent the host's credentials cannot serve. A guest env conflict
// names the first key in the agent's own config that would override them.
export function buildHarnessAuthRefusal(
  agent: string,
  target: string,
  problem: HarnessAuthRefusal,
  variable: string | null,
): DaemonError {
  const message = match(problem)
    .with(
      'broker_required',
      () =>
        `agent '${agent}' takes its credential from a credential broker, which target '${target}' does not reach`,
    )
    .with(
      'guest_env_conflict',
      () =>
        `agent '${agent}' sets ${variable ?? 'a key'} in its own config, which would override or route around the credentials that target '${target}' supplies`,
    )
    .with(
      'route_required',
      () =>
        `target '${target}' supplies credentials only through routes, so agent '${agent}' needs an auth selection to run there`,
    )
    .with(
      'auth_on_stored_token',
      () =>
        `target '${target}' supplies one stored token, so agent '${agent}' cannot select auth profiles there`,
    )
    .with(
      'sign_in_unsupported',
      () => `agent '${agent}' reads no stored token, which target '${target}' supplies`,
    )
    .exhaustive();

  return new DaemonError('auth_target_unsupported', message, {
    agent,
    target,
    problem,
    ...(variable === null ? {} : { variable }),
  });
}
