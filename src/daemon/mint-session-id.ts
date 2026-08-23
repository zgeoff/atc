import type { SessionID } from '../shared/session-id';

let counter = 0;

/**
 * A fresh atc session id: an incrementing counter joined to the current time
 * in base36. Every session the session manager spawns or restores gets one.
 */
export function mintSessionID(): SessionID {
  // oxlint-disable-next-line no-unsafe-type-assertion -- this is where atc mints a session id
  return `s${++counter}-${Date.now().toString(36)}` as SessionID;
}
