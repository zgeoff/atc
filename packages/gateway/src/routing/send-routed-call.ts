import { AtcError } from '@atcx/contract/light';
import invariant from 'tiny-invariant';
import type { DaemonPool } from '../daemons/create-daemon-pool';
import type { RoutedCall, RoutedOutcome } from '../types';

export async function sendRoutedCall(pool: DaemonPool, call: RoutedCall): Promise<RoutedOutcome> {
  const daemon = call.daemon;

  invariant(daemon, 'a routed call reached its daemon before a step picked one');

  try {
    const value = await pool
      .getCaller(daemon.name)
      .sendRequest(call.method, call.params, call.principal, call.prepareParams);

    return { kind: 'answered', daemon, value };
  } catch (error) {
    if (error instanceof AtcError) {
      return { kind: 'refused', daemon, error };
    }

    throw error;
  }
}
