import type { ClientMachineDeps } from '../client/build-client-machine';

/**
 * The screens a client machine opens, as side effects that each append
 * their name, and the session or mode they were given, to `calls` in the
 * order they run, and draw nothing.
 */
export function buildStubClientScreens() {
  const calls: string[] = [];

  const deps: ClientMachineDeps = {
    openHome: () => {
      calls.push('openHome');
    },
    openAttached: (sessionID) => {
      calls.push(`openAttached:${sessionID}`);
    },
    openOverlay: () => {
      calls.push('openOverlay');
    },
    openHelp: () => {
      calls.push('openHelp');
    },
    openPicker: (resume) => {
      calls.push(`openPicker:${resume}`);
    },
    openEject: (sessionID) => {
      calls.push(`openEject:${sessionID}`);
    },
  };

  return { deps, calls };
}
