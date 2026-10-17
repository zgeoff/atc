import { randomUUID } from 'node:crypto';
import type { SessionID } from '@atc/core';

// random rather than counted: the fleet row keeps the id across daemon restarts and restores
export function mintSessionID(): SessionID {
  // oxlint-disable-next-line no-unsafe-type-assertion -- this is where atc mints a session id
  return randomUUID() as SessionID;
}
