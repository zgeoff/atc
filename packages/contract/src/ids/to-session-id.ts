import { z } from 'zod';
import type { SessionID } from './session-id';

const SESSION_ID_SCHEMA = z.string().brand<'SessionID'>();

export function toSessionID(id: string): SessionID {
  return SESSION_ID_SCHEMA.parse(id);
}
