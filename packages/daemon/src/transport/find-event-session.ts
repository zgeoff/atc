import { isRecord } from '@atc/core';
import type { EventMsg } from '@atc/protocol/wire';
import type { SessionID } from '@atcx/contract';
import { toSessionID } from '@atcx/contract';

export function findEventSession(event: EventMsg): SessionID | null {
  if (typeof event['sessionID'] === 'string') {
    return toSessionID(event['sessionID']);
  }

  const session = event['session'];

  if (isRecord(session) && typeof session['id'] === 'string') {
    return toSessionID(session['id']);
  }

  return null;
}
