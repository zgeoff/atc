import { isRecord } from '@atc/core';
import { toPeerMethod } from './to-peer-method';

export function findPeerMethod(line: string): string | null {
  let parsed: unknown;

  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }

  if (!isRecord(parsed) || (parsed['t'] !== undefined && parsed['t'] !== 1)) {
    return null;
  }

  const payload = parsed['p'];

  if (!isRecord(payload) || typeof payload['u'] !== 'string') {
    return null;
  }

  return toPeerMethod(payload['u']);
}
