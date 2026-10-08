import type {
  ExecutionCapabilities,
  ExecutionProvider,
  HarnessSpec,
} from '../daemon/execution-provider';
import { LocalPTYProvider } from '../daemon/local-pty-provider';

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

  /**
   * Called with each harness spec before the harness starts; a throw from
   * it aborts the spawn.
   */
  readonly onSpawn?: (spec: HarnessSpec) => void;
}

interface StubExecutionProvider extends ExecutionProvider {
  // Every host the daemon put to sleep, in order.
  readonly suspended: string[];

  // Every host the daemon destroyed, in order.
  readonly destroyed: string[];

  /**
   * Rejects every host suspend with the error, recording nothing, until
   * called with null.
   */
  readonly setSuspendFailure: (error: Readonly<Error> | null) => void;

  /**
   * Rejects every host destroy with the error, recording nothing, until
   * called with null.
   */
  readonly setDestroyFailure: (error: Readonly<Error> | null) => void;
}

/**
 * An execution provider for daemon tests that runs harnesses, transfers, and
 * commands on this machine as the local pseudo-terminal provider does, with
 * the capabilities the config changes on top of its own. The config can
 * mark the host remote, and can make every command reject with an error
 * instead of running. It reports each harness spec to the config before
 * starting it. A host suspend or destroy does nothing to the machine: it records the host in `suspended` or
 * `destroyed` and resolves, or rejects with the error a failure setter gave.
 * The daemon calls them only when the capabilities declare `suspend` or
 * `destroy`.
 */
export function buildStubExecutionProvider(
  config: StubExecutionProviderConfig = {},
): StubExecutionProvider {
  const local = new LocalPTYProvider();

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
