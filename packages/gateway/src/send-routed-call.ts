import { DaemonError } from '@atc/protocol/wire';
import invariant from 'tiny-invariant';
import type { DaemonPool } from './create-daemon-pool';
import type { RoutedCall, RoutedOutcome } from './types';

// The pass-through at the end of the routing steps: the call goes to its
// daemon under any method name, and a daemon's refusal comes back as an
// outcome for the steps around it to record and rewrite.
export async function sendRoutedCall(pool: DaemonPool, call: RoutedCall): Promise<RoutedOutcome> {
  const daemon = call.daemon;

  invariant(daemon, 'a routed call reached its daemon before a step picked one');

  try {
    const value = await pool
      .getCaller(daemon.name)
      .sendRequest(call.method, call.params, call.principal, call.prepareParams);

    return { kind: 'answered', daemon, value };
  } catch (error) {
    if (error instanceof DaemonError) {
      return { kind: 'refused', daemon, error };
    }

    throw error;
  }
}
