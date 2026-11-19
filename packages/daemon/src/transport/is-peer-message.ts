import { isRecord } from '@atc/core';

// Line-protocol messages share this stream and carry a numeric id under a different key.
// Only oRPC peer messages put a string id under "i".
export function isPeerMessage(line: string): boolean {
  let parsed: unknown;

  try {
    parsed = JSON.parse(line);
  } catch {
    return false;
  }

  return isRecord(parsed) && typeof parsed['i'] === 'string';
}
