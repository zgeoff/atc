import type {
  ExecutionCapabilities,
  ExecutionProvider,
  HarnessSpec,
} from '../daemon/execution-provider';
import { LocalPTYProvider } from '../daemon/local-pty-provider';

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

/**
 * An execution provider for daemon tests that runs every harness on a real
 * local pseudo-terminal, as the `local-pty` provider does, under whatever
 * kind and capabilities the test gives it, so a target of any kind starts
 * a real process. Each spawn is reported to `onSpawn` first. Host
 * readying, sleeping, and destroying take the test's own operations when
 * given, and the local provider's otherwise: readying always succeeds, and
 * a sleep or a destroy rejects.
 */
export function buildStubPTYProvider(config: StubPTYProviderConfig = {}): ExecutionProvider {
  const local = new LocalPTYProvider();

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
