import { randomUUID } from 'node:crypto';
import type { MessageID } from '@atc/core';

// random rather than counted: the id is a persisted key that stays unique across daemon restarts
export function mintMessageID(): MessageID {
  // oxlint-disable-next-line no-unsafe-type-assertion -- this is where atc mints a message id
  return `m-${randomUUID()}` as MessageID;
}
