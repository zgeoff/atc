import type { ExecutionProvider, HarnessHandle } from '../daemon/execution-provider';
import { LocalPTYProvider } from '../daemon/local-pty-provider';

/**
 * An execution provider of kind `no-forced-kill` that runs every harness on
 * this machine through the local terminal provider, but whose harnesses
 * have no forced kill to send, as a remote provider's have none: a harness
 * that ignores its kill keeps running.
 */
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
