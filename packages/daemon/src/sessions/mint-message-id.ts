import { randomUUID } from 'node:crypto';
import type { MessageID } from '@atcx/contract';
import { toMessageID } from '@atcx/contract';

// random rather than counted: the id is a persisted key that stays unique across daemon restarts
export function mintMessageID(): MessageID {
  return toMessageID(`m-${randomUUID()}`);
}
