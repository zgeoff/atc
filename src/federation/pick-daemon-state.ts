import { DaemonError } from '../protocol/daemon-error';
import { GatewayError } from './gateway-error';
import type { CallOutcome } from './wait-for-outcome';

/**
 * A daemon's state as the gateway reports it: `up` when it answered,
 * `down` when it was unreachable or did not answer in time, `unauthorized`
 * when it refused the gateway's token, `changed` when another state
 * identity than the registry pins answered, `outdated` when it lacks a
 * feature the call needs, and `refused` when it answered the call with its
 * own error.
 */
export type DaemonState = 'up' | 'down' | 'unauthorized' | 'changed' | 'outdated' | 'refused';

/**
 * The state a daemon is in, judged by how one call to it settled.
 */
export function pickDaemonState(outcome: CallOutcome<unknown>): DaemonState {
  if (outcome.kind === 'answered') {
    return 'up';
  }

  if (outcome.kind === 'timeout') {
    return 'down';
  }

  const error = outcome.error;

  if (error instanceof GatewayError && error.code === 'daemon_unauthorized') {
    return 'unauthorized';
  }

  if (error instanceof GatewayError && error.code === 'daemon_outdated') {
    return 'outdated';
  }

  if (error instanceof GatewayError && error.data['reason'] === 'daemon_changed') {
    return 'changed';
  }

  if (error instanceof DaemonError) {
    return 'refused';
  }

  return 'down';
}
