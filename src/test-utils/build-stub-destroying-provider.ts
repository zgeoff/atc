import type { ExecutionProvider } from '../daemon/execution-provider';
import { LocalPTYProvider } from '../daemon/local-pty-provider';

/**
 * An execution provider that stands in for one whose hosts can sleep and be
 * destroyed, such as an imp: every operation runs on the daemon's own machine
 * as the local provider runs it, it declares the suspend and destroy
 * capabilities besides, a suspend does nothing, and a destroy records the
 * host in `destroyed` and leaves everything running.
 */
export function buildStubDestroyingProvider(): ExecutionProvider & {
  readonly destroyed: readonly string[];
} {
  const local = new LocalPTYProvider();

  const destroyed: string[] = [];

  return {
    kind: 'imp-like',
    remote: false,
    capabilities: { ...local.capabilities, suspend: true, destroy: true },
    destroyed,
    prepareHost: local.prepareHost,
    spawnHarness: local.spawnHarness,
    transferArchive: local.transferArchive,
    runCommand: local.runCommand,
    suspendHost: () => Promise.resolve(),
    destroyHost: (host) => {
      destroyed.push(host);

      return Promise.resolve();
    },
    dispose: local.dispose,
  };
}
