import type { Principal } from '@atc/protocol';
import type { FleetCaller } from './types';

export function buildPrincipalCaller(caller: FleetCaller, principal: Principal): FleetCaller {
  return {
    sendRequest: (method, params) => caller.sendRequest(method, params, principal),
    features: caller.features,
    waitForDaemon: () => caller.waitForDaemon(),
  };
}
