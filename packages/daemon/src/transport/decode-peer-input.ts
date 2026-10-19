import { isRecord } from '@atc/core';
import type { StandardRequest } from '@orpc/standard-server';
import { PEER_SERIALIZER } from './peer-codec';

// The params a peer request carries, decoded by the serializer the
// handler's codec decodes them with, before the procedure's schema checks
// them; a body that holds no params object decodes to none.
export function decodePeerInput(request: StandardRequest): Readonly<Record<string, unknown>> {
  const input: unknown = PEER_SERIALIZER.deserialize(request.body);

  return isRecord(input) ? input : {};
}
