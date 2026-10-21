import type { ExecutionCapabilities, ExecutionProvider, HarnessSpec } from '@atc/plugin-api';
import { createLocalPTYProvider } from '../create-local-pty-provider';

interface StubPTYProviderConfig {
  // The provider kind the stand-in reports, such as the kind a target's
  // config selects; the local provider's own kind when absent.
  readonly kind?: string;

  // Capabilities that differ from the local provider's.
  readonly capabilities?: Partial<ExecutionCapabilities>;

  // Called with each harness spec before the harness starts.
  readonly onSpawn?: (spec: HarnessSpec) => void;
  readonly prepareHost?: ExecutionProvider['prepareHost'];
  readonly suspendHost?: ExecutionProvider['suspendHost'];
  readonly destroyHost?: ExecutionProvider['destroyHost'];
}

export function createStubPTYProvider(config: StubPTYProviderConfig = {}): ExecutionProvider {
  const local = createLocalPTYProvider();
  const onSpawn = config.onSpawn ?? (() => {});

  return {
    kind: config.kind ?? local.kind,
    remote: false,
    capabilities: { ...local.capabilities, ...config.capabilities },
    prepareHost: config.prepareHost ?? local.prepareHost,
    spawnHarness: (spec) => {
      onSpawn(spec);

      return local.spawnHarness(spec);
    },
    transferArchive: local.transferArchive,
    runCommand: local.runCommand,
    suspendHost: config.suspendHost ?? local.suspendHost,
    destroyHost: config.destroyHost ?? local.destroyHost,
    dispose: local.dispose,
  };
}
