import { isRecord } from '@atc/core';
import { toPeerMethod } from './to-peer-method';

// The request method a peer line asks for, as dotted procedure path; null
// for a line that is not a request, such as an abort or an event of a
// stream the client sends, and for one that does not parse.
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
