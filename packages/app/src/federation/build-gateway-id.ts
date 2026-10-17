import type { RegistryDaemon } from './types';

export function buildGatewayID(
  daemon: Pick<RegistryDaemon, 'name' | 'incarnation'>,
  id: string,
): string {
  return `${daemon.name}.${daemon.incarnation}.${id}`;
}
