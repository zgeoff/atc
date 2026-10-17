import { DaemonError } from '@atc/protocol/wire';

// An agent that takes its credential from impd's broker on a target that
// reaches none.
export function buildBrokerTargetRefusal(agent: string, target: string): DaemonError {
  return new DaemonError(
    'auth_target_unsupported',
    `agent '${agent}' takes its credential from impd's broker, which target '${target}' does not reach`,
    { agent, target },
  );
}
