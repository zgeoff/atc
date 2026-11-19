import type { ExecutionCapabilities, ExecutionProvider, HarnessSpec } from '@atc/plugin-api';
import { createLocalPTYProvider } from '../create-local-pty-provider';

interface StubExecutionProviderConfig {
  readonly kind?: string;

  // Capabilities that differ from a local pseudo-terminal's.
  readonly capabilities?: Partial<ExecutionCapabilities>;

  readonly remote?: boolean;

  readonly commandFailure?: Readonly<Error>;

  readonly onSpawn?: (spec: HarnessSpec) => void;
}

interface StubExecutionProvider extends ExecutionProvider {
  readonly suspended: string[];

  readonly destroyed: string[];

  readonly setSuspendFailure: (error: Readonly<Error> | null) => void;

  readonly setDestroyFailure: (error: Readonly<Error> | null) => void;
}

export function createStubExecutionProvider(
  config: StubExecutionProviderConfig = {},
): StubExecutionProvider {
  const local = createLocalPTYProvider();
  const onSpawn = config.onSpawn ?? (() => {});
  const commandFailure = config.commandFailure;
  const suspended: string[] = [];
  const destroyed: string[] = [];

  const failures: { suspend: Readonly<Error> | null; destroy: Readonly<Error> | null } = {
    suspend: null,
    destroy: null,
  };

  return {
    kind: config.kind ?? 'stub',
    remote: config.remote ?? false,
    capabilities: {
      ...local.capabilities,
      relay: config.remote ?? false,
      ...config.capabilities,
    },
    prepareHost: local.prepareHost,
    spawnHarness: (spec) => {
      onSpawn(spec);

      return local.spawnHarness(spec);
    },
    transferArchive: local.transferArchive,
    runCommand:
      commandFailure === undefined ? local.runCommand : () => Promise.reject(commandFailure),
    suspendHost: (host) => {
      const failure = failures.suspend;

      if (failure !== null) {
        return Promise.reject(failure);
      }

      suspended.push(host);

      return Promise.resolve();
    },
    destroyHost: (host) => {
      const failure = failures.destroy;

      if (failure !== null) {
        return Promise.reject(failure);
      }

      destroyed.push(host);

      return Promise.resolve();
    },
    dispose: local.dispose,
    suspended,
    destroyed,
    setSuspendFailure: (error) => {
      failures.suspend = error;
    },
    setDestroyFailure: (error) => {
      failures.destroy = error;
    },
  };
}
