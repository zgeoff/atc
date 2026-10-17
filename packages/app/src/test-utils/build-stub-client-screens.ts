import type { ClientMachineDeps } from '../client/build-client-machine';

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
