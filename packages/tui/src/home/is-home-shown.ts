import type { ClientMode } from '../client/build-client-machine';

export interface HomeScreenState {
  readonly mode: ClientMode;

  // true while a session shows, or the session list is open over a live one
  readonly isSessionShown: boolean;

  // true while a prompt that the screen draws, such as the restart question, asks the user
  readonly isPrompting: boolean;
}

// True while home is the screen below everything else. It waits under the session list too, when
// no session shows, so the list keeps a screen behind it if its session dies.
export function isHomeShown(state: HomeScreenState): boolean {
  if (state.isPrompting) {
    return false;
  }

  return state.mode === 'home' || (state.mode === 'overlay' && !state.isSessionShown);
}
