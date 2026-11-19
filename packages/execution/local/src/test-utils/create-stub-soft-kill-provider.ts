import type { ExecutionProvider, HarnessHandle } from '@atc/plugin-api';
import { createLocalPTYProvider } from '../create-local-pty-provider';

// Its harnesses have no forced kill, as a remote provider's have none, so one
// that ignores its kill keeps running.
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
