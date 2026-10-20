import { systemClock } from '@atc/core';
import type { Clock } from '@atc/core';
import type {
  CommandResult,
  CommandSpec,
  CredentialBroker,
  ExecutionCapabilities,
  ExecutionProvider,
  GuestLayout,
  HarnessExit,
  HarnessHandle,
  HarnessSpec,
  HostRequest,
} from '@atc/plugin-api';

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
  readonly cloneOnTarget?: boolean;
  readonly hostGitIdentity?: boolean;
  readonly guestWorkspaceTrust?: boolean;

  // Called with each harness spec before the harness starts; a throw from it
  // aborts the spawn, and no harness is recorded.
  readonly onSpawn?: (spec: HarnessSpec) => void;

  // Answers each command; absent, every command exits 0 and prints nothing.
  readonly runCommand?: (spec: CommandSpec) => Promise<CommandResult>;

  // Unpacks each archive after the stand-in records it; absent, each
  // transfer resolves with nothing unpacked.
  readonly transferArchive?: ExecutionProvider['transferArchive'];

  // Host operations of the test's own, run after the stand-in records the
  // call; absent, each resolves.
  readonly prepareHost?: ExecutionProvider['prepareHost'];
  readonly suspendHost?: ExecutionProvider['suspendHost'];
  readonly destroyHost?: ExecutionProvider['destroyHost'];

  // The clock behind each harness's wait for its exit; the wall clock when
  // absent.
  readonly clock?: Clock;
}

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
    readonly directory: string;
    readonly host?: string;
  }[];
  readonly commands: CommandSpec[];

  // How many times the daemon disposed of the provider.
  readonly countDisposals: () => number;
}

export function buildStubMemoryProvider(config: StubMemoryProviderConfig = {}): StubMemoryProvider {
  const harnesses: StubMemoryHarness[] = [];
  const prepared: HostRequest[] = [];
  const suspended: string[] = [];
  const destroyed: string[] = [];
  const transfers: { archive: Uint8Array; directory: string; host?: string }[] = [];
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
    ...(config.cloneOnTarget === undefined ? {} : { cloneOnTarget: config.cloneOnTarget }),
    ...(config.hostGitIdentity === undefined ? {} : { hostGitIdentity: config.hostGitIdentity }),
    ...(config.guestWorkspaceTrust === undefined
      ? {}
      : { guestWorkspaceTrust: config.guestWorkspaceTrust }),
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
      const harness = buildStubMemoryHarness(spec, config.clock ?? systemClock);

      harnesses.push(harness);

      return harness;
    },
    transferArchive: (archive, directory, host) => {
      const transfer = host === undefined ? { archive, directory } : { archive, directory, host };

      transfers.push(transfer);

      return config.transferArchive?.(archive, directory, host) ?? Promise.resolve();
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

function buildStubMemoryHarness(spec: HarnessSpec, clock: Clock): StubMemoryHarness {
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
    // a process's exit arrives after its signal, never inside the kill call
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

      const cancelTimeout = clock.schedule(() => {
        exitWaiters.delete(wait.resolve);
        wait.resolve(false);
      }, timeoutMs);

      exitWaiters.add(wait.resolve);

      return wait.promise.finally(cancelTimeout);
    },
    detach: () => {
      detached = true;

      dataListeners.clear();
      exitListeners.clear();

      emitWaitOutcome(false);
    },
  };
}
