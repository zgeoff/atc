import type { FleetCaller } from '@atc/fleet-api';
import type { Principal } from '@atc/protocol';

export function buildPrincipalCaller(caller: FleetCaller, principal: Principal): FleetCaller {
  return {
    sendRequest: (method, params) => caller.sendRequest(method, params, principal),
    features: caller.features,
    waitForDaemon: () => caller.waitForDaemon(),
  };
}
