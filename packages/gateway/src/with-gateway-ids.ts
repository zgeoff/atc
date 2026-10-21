import { match } from 'ts-pattern';
import { buildGatewayError } from './build-gateway-error';
import { buildGatewayResult } from './build-gateway-result';
import { resolveDaemonRequest } from './resolve-daemon-request';
import type { GatewayRegistry, RouteNext, RoutedCall, RoutedOutcome } from './types';

// The id rules around a routed call: the gateway ids in its params go out as
// the daemon's own, and the daemon's ids in its answer or refusal come back
// as gateway ids.
export async function withGatewayIDs(
  registry: GatewayRegistry,
  call: RoutedCall,
  next: RouteNext,
): Promise<RoutedOutcome> {
  const route = resolveDaemonRequest(call.params, registry);

  const outcome = await next({ ...call, params: route.params, owner: route.daemon });

  return match(outcome)
    .with({ kind: 'answered' }, (answered) => ({
      ...answered,
      value: buildGatewayResult(call.method, answered.value, answered.daemon),
    }))
    .with({ kind: 'refused' }, (refused) => ({
      ...refused,
      error: buildGatewayError(refused.error, refused.daemon, route.requestIDs),
    }))
    .exhaustive();
}
