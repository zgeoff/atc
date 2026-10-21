import type { ExecutionCapabilities, ExecutionProvider, HarnessSpec } from '@atc/plugin-api';
import { createLocalPTYProvider } from '../create-local-pty-provider';

interface StubExecutionProviderConfig {
  // The provider kind the daemon reports for the target.
  readonly kind?: string;

  // Capabilities that differ from a local pseudo-terminal's.
  readonly capabilities?: Partial<ExecutionCapabilities>;

  // Whether the daemon treats the host as another machine; false when left
  // out.
  readonly remote?: boolean;

  // The error every command rejects with instead of running; left out,
  // commands run on this machine.
  readonly commandFailure?: Readonly<Error>;

  // A throw aborts the spawn.
  readonly onSpawn?: (spec: HarnessSpec) => void;
}

interface StubExecutionProvider extends ExecutionProvider {
  // Every host the daemon put to sleep, in order.
  readonly suspended: string[];

  // Every host the daemon destroyed, in order.
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

  // The errors a suspend and a destroy reject with, or null while they
  // succeed.
  const failures: { suspend: Readonly<Error> | null; destroy: Readonly<Error> | null } = {
    suspend: null,
    destroy: null,
  };

  return {
    kind: config.kind ?? 'stub',
    remote: config.remote ?? false,
    capabilities: { ...local.capabilities, ...config.capabilities },
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
