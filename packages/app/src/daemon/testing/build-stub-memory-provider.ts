import type { CredentialBroker } from '@atc/plugin-api/credential-broker';
import type {
  CommandResult,
  CommandSpec,
  ExecutionCapabilities,
  ExecutionProvider,
  GuestLayout,
  HarnessExit,
  HarnessHandle,
  HarnessSpec,
  HostRequest,
} from '@atc/plugin-api/execution-provider';

interface StubMemoryProviderConfig {
  // The provider kind the stand-in reports; `memory` when absent.
  readonly kind?: string;

  // Capabilities that differ from the defaults, which are a local
  // pseudo-terminal's: everything but suspend and destroy.
  readonly capabilities?: Partial<ExecutionCapabilities>;

  // Whether the daemon treats the host as another machine; false when absent.
  readonly remote?: boolean;
  readonly guest?: GuestLayout;
  readonly brokerAuth?: CredentialBroker;

  // Called with each harness spec before the harness starts; a throw from it
  // aborts the spawn, and no harness is recorded.
  readonly onSpawn?: (spec: HarnessSpec) => void;

  // Answers each command; absent, every command exits 0 and prints nothing.
  readonly runCommand?: (spec: CommandSpec) => Promise<CommandResult>;

  // Host operations of the test's own, run after the stand-in records the
  // call; absent, each resolves.
  readonly prepareHost?: ExecutionProvider['prepareHost'];
  readonly suspendHost?: ExecutionProvider['suspendHost'];
  readonly destroyHost?: ExecutionProvider['destroyHost'];
}

/**
 * One harness the in-memory provider started: the spec it started with,
 * what the daemon wrote to it and resized it to, and how it ended. A test
 * drives it as its process would, through `emitData` and `emitExit`.
 */
interface StubMemoryHarness extends HarnessHandle {
  readonly spec: HarnessSpec;
  readonly written: string[];
  readonly sizes: (readonly [cols: number, rows: number])[];

  // The exit the harness reported, or null while it runs.
  readonly readExit: () => HarnessExit | null;

  // Whether the daemon let go of the harness without ending it.
  readonly isDetached: () => boolean;
  readonly emitData: (data: string) => void;

  // Ends the harness with the exit given; a harness that already ended, or
  // that the daemon let go of, records nothing more.
  readonly emitExit: (exit: HarnessExit) => void;
}

export interface StubMemoryProvider extends ExecutionProvider {
  // Every harness started, in order.
  readonly harnesses: StubMemoryHarness[];

  // Every host readied, put to sleep, or destroyed, in order.
  readonly prepared: HostRequest[];
  readonly suspended: string[];
  readonly destroyed: string[];

  // Every archive unpacked and every command run, in order.
  readonly transfers: {
    readonly archive: Uint8Array;
    readonly dir: string;
    readonly host?: string;
  }[];
  readonly commands: CommandSpec[];

  // How many times the daemon disposed of the provider.
  readonly countDisposals: () => number;
}

/**
 * An execution provider for daemon tests that runs nothing: each harness
 * lives in memory, where the test reads what the daemon wrote to it and
 * drives its output and exit. A kill ends a harness with exit code 0 and a
 * forced kill with 137, each reported on the next microtask as a process's
 * exit arrives after its signal; a detach leaves the harness running and
 * drops every listener, as a remote host keeps a process the daemon lets go
 * of. Transfers and commands are recorded, and commands answer through the
 * config. Host operations are recorded and then take the config's own
 * operation, resolving when it has none.
 */
export function buildStubMemoryProvider(config: StubMemoryProviderConfig = {}): StubMemoryProvider {
  const harnesses: StubMemoryHarness[] = [];
  const prepared: HostRequest[] = [];
  const suspended: string[] = [];
  const destroyed: string[] = [];
  const transfers: { archive: Uint8Array; dir: string; host?: string }[] = [];
  const commands: CommandSpec[] = [];
  let disposals = 0;

  return {
    kind: config.kind ?? 'memory',
    remote: config.remote ?? false,
    capabilities: {
      spawn: true,
      attach: true,
      input: true,
      resize: true,
      kill: true,
      transfer: true,
      run: true,
      headless: true,
      suspend: false,
      destroy: false,
      ...config.capabilities,
    },
    ...(config.guest === undefined ? {} : { guest: config.guest }),
    ...(config.brokerAuth === undefined ? {} : { brokerAuth: config.brokerAuth }),
    harnesses,
    prepared,
    suspended,
    destroyed,
    transfers,
    commands,
    countDisposals: () => disposals,
    prepareHost: (request) => {
      prepared.push(request);

      return config.prepareHost?.(request) ?? Promise.resolve();
    },
    spawnHarness: (spec) => {
      config.onSpawn?.(spec);
      const harness = buildStubMemoryHarness(spec);

      harnesses.push(harness);

      return harness;
    },
    transferArchive: (archive, dir, host) => {
      const transfer = host === undefined ? { archive, dir } : { archive, dir, host };

      transfers.push(transfer);

      return Promise.resolve();
    },
    runCommand: (spec) => {
      commands.push(spec);

      return config.runCommand?.(spec) ?? Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    },
    suspendHost: (host, isIdle) => {
      suspended.push(host);

      return config.suspendHost?.(host, isIdle) ?? Promise.resolve();
    },
    destroyHost: (host) => {
      destroyed.push(host);

      return config.destroyHost?.(host) ?? Promise.resolve();
    },
    dispose: () => {
      disposals += 1;
    },
  };
}

function buildStubMemoryHarness(spec: HarnessSpec): StubMemoryHarness {
  const dataListeners = new Set<(data: string) => void>();
  const exitListeners = new Set<(exit: HarnessExit) => void>();
  const exitWaiters = new Set<(exited: boolean) => void>();

  const written: string[] = [];
  const sizes: (readonly [number, number])[] = [];
  let exit: HarnessExit | null = null;
  let detached = false;

  // Settles every pending exit wait: true on an exit, false once the
  // harness stops being followed without one.
  const emitWaitOutcome = (exited: boolean): void => {
    for (const waiter of exitWaiters) {
      waiter(exited);
    }

    exitWaiters.clear();
  };

  const emitExit = (next: HarnessExit): void => {
    if (exit !== null || detached) {
      return;
    }

    exit = next;

    for (const listener of exitListeners) {
      listener(next);
    }

    emitWaitOutcome(true);
  };

  const scheduleExit = (exitCode: number): void => {
    queueMicrotask(() => {
      emitExit({ exitCode });
    });
  };

  return {
    spec,
    written,
    sizes,
    readExit: () => exit,
    isDetached: () => detached,
    emitData: (data) => {
      for (const listener of dataListeners) {
        listener(data);
      }
    },
    emitExit,
    onData: (listener) => {
      dataListeners.add(listener);

      return {
        dispose: () => {
          dataListeners.delete(listener);
        },
      };
    },
    onExit: (listener) => {
      exitListeners.add(listener);

      return {
        dispose: () => {
          exitListeners.delete(listener);
        },
      };
    },
    write: (data) => {
      written.push(data);
    },
    resize: (cols, rows) => {
      sizes.push([cols, rows]);
    },
    kill: () => {
      scheduleExit(0);
    },
    killForced: () => {
      scheduleExit(137);
    },
    waitForExit: (timeoutMs) => {
      if (exit !== null) {
        return Promise.resolve(true);
      }

      const wait = Promise.withResolvers<boolean>();

      const timer = setTimeout(() => {
        exitWaiters.delete(wait.resolve);
        wait.resolve(false);
      }, timeoutMs);

      exitWaiters.add(wait.resolve);

      return wait.promise.finally(() => {
        clearTimeout(timer);
      });
    },
    detach: () => {
      detached = true;

      dataListeners.clear();
      exitListeners.clear();

      emitWaitOutcome(false);
    },
  };
}
