import type { MirrorSession } from '../fleet/to-mirror-session';
import type { ClientMode, RestartConsent } from './build-client-machine';

// True while a session shows, or while the session list is open over a live focused one, which the
// list returns to.
export function isOverSession(
  mode: ClientMode,
  consent: RestartConsent | null,
  focused: MirrorSession | null,
): boolean {
  if (mode === 'attached') {
    return consent === null;
  }

  return mode === 'overlay' && focused?.alive === true;
}
