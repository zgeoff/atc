import type { Principal } from '@atc/protocol';
import type { FleetCaller } from './types';

/**
 * The caller every request of one remote MCP client rides: each request acts
 * as the client's principal, whatever principal it asked for, and goes only
 * to a daemon that limits a request to its principal's targets, so a daemon
 * that would ignore the principal never answers it with the owner's reach.
 * Each request carries the client's name too, and goes only to a daemon
 * that labels a message with it, so no daemon labels one with a name the
 * request did not vouch for.
 */
export function buildPrincipalCaller(caller: FleetCaller, principal: Principal): FleetCaller {
  return {
    sendRequest: (m, p, required = []) =>
      caller.sendRequest(m, p, [...required, 'request.principal', 'message.sender'], principal),
    readFeatures: () => caller.readFeatures(),
  };
}
