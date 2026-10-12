import type { ExecutionProvider } from '../daemon/execution-provider';
import { LocalPTYProvider } from '../daemon/local-pty-provider';

/**
 * An execution provider of kind `imp-like` whose hosts can be put to sleep
 * and destroyed, as an imp's can, while every harness, archive transfer, and
 * command runs on this machine through the local terminal provider.
 * Readying, suspending, and destroying a host each do nothing and settle at
 * once.
 */
export function buildStubHostProvider(): ExecutionProvider {
  const local = new LocalPTYProvider();

  return {
    kind: 'imp-like',
    remote: false,
    capabilities: { ...local.capabilities, suspend: true, destroy: true },
    prepareHost: () => Promise.resolve(),
    spawnHarness: local.spawnHarness,
    transferArchive: local.transferArchive,
    runCommand: local.runCommand,
    suspendHost: () => Promise.resolve(),
    destroyHost: () => Promise.resolve(),
    dispose: local.dispose,
  };
}
