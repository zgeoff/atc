import type { ClientMachineDeps } from '../build-client-machine';

export function buildStubClientScreens() {
  const calls: string[] = [];

  const deps: ClientMachineDeps = {
    openHome: () => {
      calls.push('openHome');
    },
    openAttached: (key) => {
      calls.push(`openAttached:${key.id}`);
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
    openEject: (key) => {
      calls.push(`openEject:${key.id}`);
    },
  };

  return { deps, calls };
}
