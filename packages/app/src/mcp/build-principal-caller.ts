import type { FleetCaller } from './types';

/**
 * The caller every request of one remote MCP client rides: each request acts
 * as the client's principal, whatever principal it asked for, and goes only
 * to a daemon that limits a request to its principal's targets, so a daemon
 * that would ignore the principal never answers it with the owner's reach.
 */
export function buildPrincipalCaller(caller: FleetCaller, principal: string): FleetCaller {
  return {
    sendRequest: (m, p, required = []) =>
      caller.sendRequest(m, p, [...required, 'request.principal'], principal),
    readFeatures: () => caller.readFeatures(),
  };
}
