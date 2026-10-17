import { DaemonError } from '@atc/protocol/wire';
import { GatewayError } from './gateway-error';
import type { CallOutcome } from './wait-for-outcome';

export type DaemonState = 'up' | 'down' | 'unauthorized' | 'changed' | 'outdated' | 'refused';

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
