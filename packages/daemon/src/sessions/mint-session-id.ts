import { randomUUID } from 'node:crypto';
import type { SessionID } from '@atcx/contract';
import { toSessionID } from '@atcx/contract';

// random rather than counted: the fleet row keeps the id across daemon restarts and restores
export function mintSessionID(): SessionID {
  return toSessionID(randomUUID());
}
