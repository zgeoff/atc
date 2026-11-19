import type { ExecutionProvider, HarnessSpec, HostRequest } from '@atc/plugin-api';
import { createLocalPTYProvider } from '../create-local-pty-provider';

// Each host preparation holds until the test releases that host, so a test
// can act while a harness is still starting.
export function createStubHeldProvider() {
  const local = createLocalPTYProvider();

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

      await local.prepareHost(request);
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
