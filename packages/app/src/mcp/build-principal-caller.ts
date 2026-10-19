import type { Principal } from '@atc/protocol';
import type { FleetCaller } from './types';

export function buildPrincipalCaller(caller: FleetCaller, principal: Principal): FleetCaller {
  return {
    sendRequest: (m, p) => caller.sendRequest(m, p, principal),
    readFeatures: () => caller.readFeatures(),
  };
}
