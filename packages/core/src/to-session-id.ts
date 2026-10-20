import { toTagged } from '@zgeoff/std';
import type { SessionID } from './session-id';

export function toSessionID(id: string): SessionID {
  return toTagged<SessionID>(id);
}
