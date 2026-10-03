import type { SessionID } from '../shared/session-id';

/**
 * One line a hook reporter sends: the atc session it reports on, the agent's
 * hook event name, and the hook's payload as the agent gave it.
 */
export interface HookEvent {
  atcId: SessionID;
  event: string;
  payload: Record<string, unknown>;
}
