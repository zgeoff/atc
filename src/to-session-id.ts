import type { SessionID } from './session-id';

/**
 * A literal string as an atc session id. Sessions are minted by the session
 * manager; this stands one in for a fixture that needs an id without a live
 * session behind it.
 */
export function toSessionID(id: string): SessionID {
  // oxlint-disable-next-line no-unsafe-type-assertion -- a stand-in for an id the session manager would mint
  return id as SessionID;
}
