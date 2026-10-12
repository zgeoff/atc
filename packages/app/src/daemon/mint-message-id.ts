import { randomUUID } from 'node:crypto';
import type { MessageID } from '../shared/message-id';

/**
 * A fresh atc message id: a random uuid behind an `m-` prefix. The id is a
 * persisted primary key, so it is random rather than counted and stays
 * unique across daemon restarts.
 */
export function mintMessageID(): MessageID {
  // oxlint-disable-next-line no-unsafe-type-assertion -- this is where atc mints a message id
  return `m-${randomUUID()}` as MessageID;
}
