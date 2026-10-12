import type { ExecutionProvider, HarnessSpec, HostRequest } from '../daemon/execution-provider';
import { LocalPTYProvider } from '../daemon/local-pty-provider';

/**
 * An execution provider that runs on this machine as the local
 * pseudo-terminal provider does, except that each host preparation holds
 * until the test calls `release` with that host, so a test can act while a
 * harness is still starting. `prepares` holds the host of each preparation
 * in the order it began, and `harnesses` each harness spec in the order it
 * started.
 */
export function buildStubHeldProvider() {
  const local = new LocalPTYProvider();
  const gates = new Map<string, PromiseWithResolvers<void>>();

  const prepares: string[] = [];
  const harnesses: HarnessSpec[] = [];

  const getGate = (host: string): PromiseWithResolvers<void> => {
    const gate = gates.get(host) ?? Promise.withResolvers<void>();

    gates.set(host, gate);

    return gate;
  };

  const provider: ExecutionProvider = {
    kind: local.kind,
    remote: local.remote,
    capabilities: local.capabilities,
    prepareHost: async (request: HostRequest) => {
      prepares.push(request.host);

      await getGate(request.host).promise;

      await local.prepareHost();
    },
    spawnHarness: (spec) => {
      harnesses.push(spec);

      return local.spawnHarness(spec);
    },
    transferArchive: local.transferArchive,
    runCommand: local.runCommand,
    suspendHost: local.suspendHost,
    destroyHost: local.destroyHost,
    dispose: local.dispose,
  };

  return {
    provider,
    prepares,
    harnesses,
    release: (host: string) => {
      getGate(host).resolve();
    },
  };
}
