import { AtcError } from '@atcx/contract/light';
import invariant from 'tiny-invariant';
import type { GatewayRegistry, RouteNext, RoutedCall, RoutedOutcome } from '../types';

export function withDaemonPick(
  registry: GatewayRegistry,
  call: RoutedCall,
  next: RouteNext,
): Promise<RoutedOutcome> {
  if (call.owner !== null && call.named !== null && call.owner !== call.named) {
    throw new AtcError(
      'bad_args',
      `the call's ids belong to daemon '${call.owner.name}', not '${call.named.name}'`,
    );
  }

  const fallback = registry.daemons.get(registry.defaultDaemon);

  invariant(fallback, 'the registry default daemon is missing from the registry');

  return next({ ...call, daemon: call.owner ?? call.named ?? fallback });
}
