import { isRecord } from '@atc/core';
import type { StandardRequest } from '@orpc/standard-server';
import { PEER_SERIALIZER } from './peer-serializer';

export function decodePeerInput(request: StandardRequest): Readonly<Record<string, unknown>> {
  const input: unknown = PEER_SERIALIZER.deserialize(request.body);

  return isRecord(input) ? input : {};
}
