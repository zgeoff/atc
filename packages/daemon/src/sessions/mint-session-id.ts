import { randomUUID } from 'node:crypto';
import type { SessionID } from '@atc/core';
import { toTagged } from '@zgeoff/std';

// random rather than counted: the fleet row keeps the id across daemon restarts and restores
export function mintSessionID(): SessionID {
  return toTagged<SessionID>(randomUUID());
}
