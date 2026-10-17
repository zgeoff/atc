import type { ExecutionProvider, HarnessHandle } from '@atc/plugin-api';
import { LocalPTYProvider } from '../local-pty-provider';

// Its harnesses have no forced kill, as a remote provider's have none, so one
// that ignores its kill keeps running.
export function buildStubSoftKillProvider(): ExecutionProvider {
  const local = new LocalPTYProvider();

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
