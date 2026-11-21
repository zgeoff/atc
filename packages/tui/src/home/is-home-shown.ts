import type { ClientMode } from '../client/build-client-machine';

// True while home is the screen below everything else. It waits under the session list too, when
// no session shows, so the list keeps a screen behind it if its session dies.
export function isHomeShown(mode: ClientMode, isSessionShown: boolean): boolean {
  return mode === 'home' || (mode === 'overlay' && !isSessionShown);
}
