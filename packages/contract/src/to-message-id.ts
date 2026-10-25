import { z } from 'zod';
import type { MessageID } from './message-id';

const MESSAGE_ID_SCHEMA = z.string().brand<'MessageID'>();

export function toMessageID(id: string): MessageID {
  return MESSAGE_ID_SCHEMA.parse(id);
}
