import type { Principal } from '@atc/protocol';
import type { FleetCaller } from './types';

export function buildPrincipalCaller(caller: FleetCaller, principal: Principal): FleetCaller {
  return {
    sendRequest: (m, p, required = []) =>
      caller.sendRequest(m, p, [...required, 'request.principal', 'message.sender'], principal),
    readFeatures: () => caller.readFeatures(),
  };
}
