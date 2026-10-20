import { toTagged } from '@zgeoff/std';
import type { MessageID } from './message-id';

export function toMessageID(id: string): MessageID {
  return toTagged<MessageID>(id);
}
