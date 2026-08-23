import type { SessionID } from './session-id';

/**
 * Trusts a string as an atc session id. This is the one point in the
 * codebase where a plain string becomes a `SessionID`, and it adds no
 * runtime check: the caller asserts the string identifies an atc session.
 */
export function toSessionID(id: string): SessionID {
  // oxlint-disable-next-line no-unsafe-type-assertion -- the one point where a string is trusted as a SessionID
  return id as SessionID;
}
