import { RESOLVE_HOME_SCRIPT } from '../sessions/host-dir-claims';
import { buildStubMemoryProvider } from './build-stub-memory-provider';

// Stands in for a remote host whose home is /home/guest and where a relative
// directory cannot be entered, as one removed inside the guest cannot; every
// other command echoes its fourth argument as a resolved directory.
export function buildStubStaleRelativeProvider() {
  return buildStubMemoryProvider({
    capabilities: { suspend: true, destroy: true },
    runCommand: (spec) => {
      if (spec.argv[2] === RESOLVE_HOME_SCRIPT) {
        return Promise.resolve({ exitCode: 0, stdout: '/home/guest\n', stderr: '' });
      }

      if (spec.cwd !== undefined && !spec.cwd.startsWith('/')) {
        return Promise.resolve({ exitCode: 1, stdout: '', stderr: 'no such directory\n' });
      }

      return Promise.resolve({ exitCode: 0, stdout: `${spec.argv[4] ?? ''}\n\0`, stderr: '' });
    },
  });
}
