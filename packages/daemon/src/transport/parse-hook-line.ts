import { isRecord, toSessionID } from '@atc/core';
import type { HookEvent } from '@atc/protocol/session';

export function parseHookLine(line: string): HookEvent | null {
  let parsed: unknown;

  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }

  if (
    !isRecord(parsed) ||
    typeof parsed['atcId'] !== 'string' ||
    typeof parsed['event'] !== 'string' ||
    !isRecord(parsed['payload'])
  ) {
    return null;
  }

  const agent = parsed['agent'];

  return {
    atcId: toSessionID(parsed['atcId']),
    ...(typeof agent === 'string' && agent !== '' ? { agent } : {}),
    event: parsed['event'],
    payload: parsed['payload'],
  };
}
