import type { RegistryDaemon } from './types';

/**
 * The id the gateway returns for a daemon's id: `<name>.<incarnation>.<id>`.
 * The name is the daemon's logical identity and the incarnation the state
 * identity pinned behind it, so an id held across a rebind of the name
 * never reaches the new daemon.
 */
export function buildGatewayID(
  daemon: Pick<RegistryDaemon, 'name' | 'incarnation'>,
  id: string,
): string {
  return `${daemon.name}.${daemon.incarnation}.${id}`;
}
