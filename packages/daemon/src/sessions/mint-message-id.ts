import { randomUUID } from 'node:crypto';
import type { MessageID } from '@atc/core';
import { toTagged } from '@zgeoff/std';

// random rather than counted: the id is a persisted key that stays unique across daemon restarts
export function mintMessageID(): MessageID {
  return toTagged<MessageID>(`m-${randomUUID()}`);
}
