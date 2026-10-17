import type { SessionID } from './session-id';

export function toSessionID(id: string): SessionID {
  // oxlint-disable-next-line no-unsafe-type-assertion -- the one point where a string is trusted as a SessionID
  return id as SessionID;
}
