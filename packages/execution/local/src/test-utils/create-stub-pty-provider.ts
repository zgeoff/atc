import type { ExecutionCapabilities, ExecutionProvider, HarnessSpec } from '@atc/plugin-api';
import { createLocalPTYProvider } from '../create-local-pty-provider';

interface StubPTYProviderConfig {
  readonly kind?: string;

  readonly capabilities?: Partial<ExecutionCapabilities>;

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
