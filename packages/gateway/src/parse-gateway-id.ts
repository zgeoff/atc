import type { GatewayRegistry, RegistryDaemon } from './types';

export function parseGatewayID(
  value: string,
  registry: GatewayRegistry,
): { readonly daemon: RegistryDaemon; readonly id: string } | null {
  const first = value.indexOf('.');
  const second = first === -1 ? -1 : value.indexOf('.', first + 1);

  if (second === -1) {
    return null;
  }

  const daemon = registry.daemons.get(value.slice(0, first));
  const id = value.slice(second + 1);

  if (daemon === undefined || value.slice(first + 1, second) !== daemon.incarnation || id === '') {
    return null;
  }

  return { daemon, id };
}
