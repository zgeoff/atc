import { systemClock } from '@atc/core';
import type { Clock } from '@atc/core';
import type {
  CommandResult,
  CommandSpec,
  ExecutionCapabilities,
  ExecutionProvider,
  GuestLayout,
  HarnessExit,
  HarnessHandle,
  HarnessSpec,
  HarnessStart,
  HostCredentials,
  HostRequest,
} from '@atc/plugin-api';

export interface StubMemoryHarness extends HarnessHandle {
  readonly spec: HarnessSpec;
  readonly written: string[];
  readonly sizes: (readonly [cols: number, rows: number])[];

  readonly readExit: () => HarnessExit | null;

  readonly isDetached: () => boolean;
  readonly emitData: (data: string) => void;

  readonly onInput: (listener: (data: string) => void) => ReturnType<HarnessHandle['onData']>;

  readonly emitExit: (exit: HarnessExit) => void;

  readonly holdExit: () => void;

  readonly hasExitWaiters: () => boolean;
}

interface StubMemoryProviderConfig {
  readonly kind?: string;

  readonly capabilities?: Partial<ExecutionCapabilities>;

  readonly remote?: boolean;

  readonly guest?: Omit<GuestLayout, 'signIn'> & { readonly signIn?: string | null };
  readonly credentials?: HostCredentials;
  readonly cloneOnTarget?: boolean;
  readonly hostGitIdentity?: boolean;
  readonly guestWorkspaceTrust?: boolean;

  readonly onSpawn?: (spec: HarnessSpec) => void;

  readonly onStart?: (harness: StubMemoryHarness) => void;

  readonly harnessStart?: HarnessStart;

  readonly harnessStartRefusal?: Error;

  readonly readHarnessFates?: ExecutionProvider['readHarnessFates'];

  readonly runCommand?: (spec: CommandSpec) => Promise<CommandResult>;

  readonly transferArchive?: ExecutionProvider['transferArchive'];

  readonly prepareHost?: ExecutionProvider['prepareHost'];
  readonly suspendHost?: ExecutionProvider['suspendHost'];
  readonly destroyHost?: ExecutionProvider['destroyHost'];

  readonly clock?: Clock;
}

export interface StubMemoryProvider extends ExecutionProvider {
  readonly harnesses: StubMemoryHarness[];

  readonly prepared: HostRequest[];
  readonly suspended: string[];
  readonly destroyed: string[];

  readonly transfers: {
    readonly archive: Uint8Array;
    readonly directory: string;
    readonly host?: string;
  }[];
  readonly commands: CommandSpec[];

  readonly holdCommands: () => void;
  readonly finishCommands: () => void;
  readonly hasHeldCommands: () => boolean;

  readonly countDisposals: () => number;
}

export function buildStubMemoryProvider(config: StubMemoryProviderConfig = {}): StubMemoryProvider {
  const harnesses: StubMemoryHarness[] = [];
  const prepared: HostRequest[] = [];
  const suspended: string[] = [];
  const destroyed: string[] = [];
  const transfers: { archive: Uint8Array; directory: string; host?: string }[] = [];
  const commands: CommandSpec[] = [];
  const guest = config.guest;
  let disposals = 0;
  let heldCommands: PromiseWithResolvers<void> | null = null;
  let waitingCommands = 0;

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
      relay: config.remote ?? false,
      ...config.capabilities,
    },
    ...(guest === undefined
      ? {}
      : { readGuest: () => Promise.resolve({ ...guest, signIn: guest.signIn ?? null }) }),
    ...(config.credentials === undefined ? {} : { credentials: config.credentials }),
    ...(config.readHarnessFates === undefined ? {} : { readHarnessFates: config.readHarnessFates }),
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
    holdCommands: () => {
      heldCommands = Promise.withResolvers<void>();
    },
    finishCommands: () => {
      heldCommands?.resolve();
      heldCommands = null;
    },
    hasHeldCommands: () => waitingCommands > 0,
    countDisposals: () => disposals,
    prepareHost: (request) => {
      prepared.push(request);

      return config.prepareHost?.(request) ?? Promise.resolve();
    },
    spawnHarness: (spec) => {
      config.onSpawn?.(spec);
      const built = buildStubMemoryHarness(spec, config.clock ?? systemClock);
      const harness = buildStartedHarness(built, config);

      harnesses.push(harness);
      config.onStart?.(harness);

      return harness;
    },
    transferArchive: (archive, directory, host) => {
      const transfer = host === undefined ? { archive, directory } : { archive, directory, host };

      transfers.push(transfer);

      return config.transferArchive?.(archive, directory, host) ?? Promise.resolve();
    },
    runCommand: async (spec) => {
      commands.push(spec);

      if (heldCommands !== null) {
        waitingCommands += 1;

        await heldCommands.promise;

        waitingCommands -= 1;
      }

      return config.runCommand?.(spec) ?? { exitCode: 0, stdout: '', stderr: '' };
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
  const inputListeners = new Set<(data: string) => void>();
  const exitWaiters = new Set<(exited: boolean) => void>();

  const written: string[] = [];
  const sizes: (readonly [number, number])[] = [];
  let exit: HarnessExit | null = null;
  let detached = false;
  let exitHeld = false;

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
    if (exitHeld) {
      return;
    }

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
    holdExit: () => {
      exitHeld = true;
    },
    hasExitWaiters: () => exitWaiters.size > 0,
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
    onInput: (listener) => {
      inputListeners.add(listener);

      return {
        dispose: () => {
          inputListeners.delete(listener);
        },
      };
    },
    write: (data) => {
      written.push(data);

      for (const listener of inputListeners) {
        listener(data);
      }
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
      inputListeners.clear();

      emitWaitOutcome(false);
    },
  };
}

function buildStartedHarness(
  harness: StubMemoryHarness,
  config: StubMemoryProviderConfig,
): StubMemoryHarness {
  const refusal = config.harnessStartRefusal;
  const harnessStart = config.harnessStart;

  if (refusal !== undefined) {
    return { ...harness, waitForStart: () => Promise.reject(refusal) };
  }

  if (harnessStart !== undefined) {
    return { ...harness, waitForStart: () => Promise.resolve(harnessStart) };
  }

  return harness;
}
