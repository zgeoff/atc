import { createFleetClient, createFleetRouter } from '@atc/fleet-api';
import type { FleetCaller, FleetClient } from '@atc/fleet-api';
import type { Principal } from '@atc/protocol';
import { FLEET_CONTRACT, GRANT_SCOPES, LOCAL_FLEET_CONTRACT } from '@atcx/contract';

export function createTestFleetClient(
  caller: FleetCaller,
  principal: Principal | null = null,
): FleetClient {
  const contract = caller.features.has('fleet.daemons') ? FLEET_CONTRACT : LOCAL_FLEET_CONTRACT;

  return createFleetClient(createFleetRouter({ caller, contract }), {
    principal,
    scopes: GRANT_SCOPES,
  });
}
