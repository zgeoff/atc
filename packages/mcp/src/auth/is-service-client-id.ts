import { buildServiceClientID } from './build-service-client-id';

export function isServiceClientID(clientID: string): boolean {
  return clientID.startsWith(buildServiceClientID(''));
}
