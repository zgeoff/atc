import type { ExecutionProvider, HarnessHandle } from '@atc/plugin-api';
import { createLocalPTYProvider } from '../create-local-pty-provider';

// Remote providers give harnesses no forced kill, so this stub drops it as well: a harness
// that ignores its soft kill keeps running, as it would on a remote host.
export function createStubSoftKillProvider(): ExecutionProvider {
  const local = createLocalPTYProvider();

  return {
    kind: 'no-forced-kill',
    remote: false,
    capabilities: local.capabilities,
    prepareHost: local.prepareHost,
    spawnHarness: (spec): HarnessHandle => {
      const { killForced: _killForced, ...handle } = local.spawnHarness(spec);

      return handle;
    },
    transferArchive: local.transferArchive,
    runCommand: local.runCommand,
    suspendHost: local.suspendHost,
    destroyHost: local.destroyHost,
    dispose: local.dispose,
  };
}
