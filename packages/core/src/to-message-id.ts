import type { MessageID } from './message-id';

export function toMessageID(id: string): MessageID {
  // oxlint-disable-next-line no-unsafe-type-assertion -- the one point where a string is trusted as a MessageID
  return id as MessageID;
}
