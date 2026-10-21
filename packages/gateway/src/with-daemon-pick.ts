import { DaemonError } from '@atc/protocol/wire';
import invariant from 'tiny-invariant';
import type { GatewayRegistry, RouteNext, RoutedCall, RoutedOutcome } from './types';

// A call goes to the daemon its ids belong to, then to the one its `daemon`
// param names, then to the default daemon, and never fails over.
export function withDaemonPick(
  registry: GatewayRegistry,
  call: RoutedCall,
  next: RouteNext,
): Promise<RoutedOutcome> {
  if (call.owner !== null && call.named !== null && call.owner !== call.named) {
    throw new DaemonError(
      'bad_args',
      `the call's ids belong to daemon '${call.owner.name}', not '${call.named.name}'`,
    );
  }

  const fallback = registry.daemons.get(registry.defaultDaemon);

  invariant(fallback, 'the registry default daemon is missing from the registry');

  return next({ ...call, daemon: call.owner ?? call.named ?? fallback });
}
