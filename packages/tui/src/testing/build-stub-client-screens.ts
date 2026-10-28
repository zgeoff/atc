import type { ClientMachineDeps } from '../build-client-machine';

export function buildStubClientScreens() {
  const calls: string[] = [];

  const deps: ClientMachineDeps = {
    openHome: () => {
      calls.push('openHome');
    },
    openAttached: (sessionID) => {
      calls.push(`openAttached:${sessionID}`);
    },
    closeAttached: () => {
      calls.push('closeAttached');
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
