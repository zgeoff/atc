import { randomUUID } from 'node:crypto';
import type { SessionID } from '../shared/session-id';

/**
 * A fresh atc session id: a random uuid. Every session the session manager
 * spawns gets one, and the fleet row keeps it, so the id stays the same
 * across daemon restarts and fleet restores.
 */
export function mintSessionID(): SessionID {
  // oxlint-disable-next-line no-unsafe-type-assertion -- this is where atc mints a session id
  return randomUUID() as SessionID;
}
