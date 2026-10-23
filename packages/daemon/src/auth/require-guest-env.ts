import { isBrokerVariable } from '@atc/core';
import { DaemonError } from '@atc/protocol/wire';

// A guest plan's variables start the harness as they are, so none may be
// one atc sets for its own reporting, and behind the broker none may be a
// proxy or CA variable that would route around the broker.
export function requireGuestEnv(
  agent: string,
  target: string,
  env: Readonly<Record<string, string>>,
  behindBroker: boolean,
): void {
  const own = Object.keys(env).find((key) => key.startsWith('ATC_'));

  if (own !== undefined) {
    throw new Error(`agent '${agent}' plans ${own}, which atc sets for the harness itself`);
  }

  const broker = behindBroker ? Object.keys(env).find((key) => isBrokerVariable(key)) : undefined;

  if (broker !== undefined) {
    throw new DaemonError(
      'auth_target_unsupported',
      `agent '${agent}' plans ${broker} on target '${target}', which would route around the target's broker`,
      { agent, target, problem: 'guest_env_conflict', variable: broker },
    );
  }
}
