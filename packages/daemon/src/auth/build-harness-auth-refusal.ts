import { AtcError } from '@atcx/contract/light';
import { match } from 'ts-pattern';
import type { HarnessAuthRefusal } from './decide-harness-auth';

export function buildHarnessAuthRefusal(
  agent: string,
  target: string,
  problem: HarnessAuthRefusal,
  variable: string | null,
): AtcError {
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

  return new AtcError('auth_target_unsupported', message, {
    agent,
    target,
    problem,
    ...(variable === null ? {} : { variable }),
  });
}
