import { isRecord } from '@atc/core/is-record';
import { toSessionID } from '@atc/core/to-session-id';
import type { HookEvent } from '@atc/protocol/hook-event';

/**
 * One reporter line as a hook event, or null for a line that is not one.
 */
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
