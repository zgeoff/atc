import type { MessageID } from './message-id';

/**
 * Trusts a string as an atc message id. This is the one point in the
 * codebase where a plain string becomes a `MessageID`, and it adds no
 * runtime check: the caller asserts the string identifies an atc message.
 */
export function toMessageID(id: string): MessageID {
  // oxlint-disable-next-line no-unsafe-type-assertion -- the one point where a string is trusted as a MessageID
  return id as MessageID;
}
