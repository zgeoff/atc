import { setTimeout as sleep } from 'node:timers/promises';
import type {
  HarnessAttachment,
  HarnessExit,
  HarnessHandle,
  HarnessStart,
  OpenedRelay,
} from '@atc/plugin-api';
import { DaemonError } from '@atc/protocol/wire';
import type { ContainerAttachment, ContainerSpec, DockerEngine } from '../engine/types';
import { pickHarnessStart } from './pick-harness-start';
import { requireOwnContainer } from './require-own-container';
import { waitOut } from './wait-out';

interface DockerHarnessOptions {
  readonly engine: DockerEngine;

  // the container to create when the Engine holds none that the harness can attach to
  readonly container: ContainerSpec;
  readonly relay: OpenedRelay;
  readonly reconnectDelaysMs: readonly number[];
  readonly log: (line: string) => void;

  // runs once the harness has exited or been detached
  readonly onDone: () => void;
}

export interface DockerHarness extends HarnessHandle {
  readonly onAttachment: NonNullable<HarnessHandle['onAttachment']>;
  readonly waitForStart: NonNullable<HarnessHandle['waitForStart']>;
  readonly killForced: NonNullable<HarnessHandle['killForced']>;
}

// Follows the harness container of a session: it attaches to one the Engine still runs, and
// otherwise removes an exited one and creates the container that runs the spec's command. A start
// that fails arrives as an exit, since the daemon waits on a start only for a brokered launch.
export function createDockerHarness(options: DockerHarnessOptions): DockerHarness {
  const engine = options.engine;
  const name = options.container.name;

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  const dataListeners: ((data: string) => void)[] = [];
  const exitListeners: ((exit: HarnessExit) => void)[] = [];
  const attachmentListeners: ((attachment: HarnessAttachment) => void)[] = [];
  const exitWaiters: ((exited: boolean) => void)[] = [];
  const started = Promise.withResolvers<HarnessStart>();

  // an unawaited rejection never crashes the daemon
  void waitOut(started.promise);
  let attachment: ContainerAttachment | null = null;
  let isFinished = false;
  let hasExited = false;
  let isKillRequested = false;
  let isRunning = false;
  let size = options.container.size ?? { cols: 80, rows: 24 };
  const queuedInput: Uint8Array[] = [];

  const finish = (): void => {
    isFinished = true;

    options.relay.stop();
    attachment?.detach();
    attachment = null;

    options.onDone();
  };

  const emitExit = (exit: HarnessExit, refusal?: DaemonError): void => {
    if (isFinished) {
      return;
    }

    hasExited = true;

    finish();

    started.reject(
      refusal ??
        new DaemonError(
          'host_unavailable',
          `docker container ${name} ended before the harness started (${exit.detail ?? 'process exited'})`,
          { provider: 'docker', problem: 'not_started' },
        ),
    );

    for (const listener of exitListeners) {
      listener(exit);
    }

    for (const waiter of exitWaiters.splice(0)) {
      waiter(true);
    }
  };

  const follow = (next: ContainerAttachment): void => {
    attachment = next;

    next.onData((data) => {
      const text = decoder.decode(data, { stream: true });

      for (const listener of dataListeners) {
        listener(text);
      }
    });

    next.onEnd(() => {
      if (attachment === next && !isFinished) {
        void restoreAttach();
      }
    });

    for (const chunk of queuedInput.splice(0)) {
      void waitOut(next.write(chunk));
    }
  };

  const emitAttachment = (state: HarnessAttachment): void => {
    for (const listener of attachmentListeners) {
      listener(state);
    }
  };

  // An attach that ended while the container still stands reattaches; the Engine replays the
  // screen on each attach. A container that exited is the harness's exit.
  const restoreAttach = async (): Promise<void> => {
    emitAttachment('reattaching');

    for (let attempt = 0; attempt <= options.reconnectDelaysMs.length; attempt += 1) {
      try {
        const container = await engine.readContainer(name);

        if (isFinished) {
          return;
        }

        if (container === null) {
          emitExit({ exitCode: 1, reason: 'ended', detail: 'the harness container is gone' });

          return;
        }

        if (container.status === 'exited' || container.status === 'dead') {
          emitExit({ exitCode: container.exitCode, reason: 'exited' });

          return;
        }

        const reattached = await engine.attachContainer(name, { stdin: true, logs: true });

        follow(reattached);
        emitAttachment('attached');

        return;
      } catch (error) {
        options.log(
          `docker harness ${name} could not reattach (${error instanceof Error ? error.message : String(error)})`,
        );
      }

      const delayMs = options.reconnectDelaysMs[attempt];

      if (delayMs !== undefined) {
        await sleep(delayMs);
      }

      if (isFinished) {
        return;
      }
    }

    emitExit({
      exitCode: 1,
      reason: 'ended',
      detail: 'the harness container cannot be reattached',
    });
  };

  const startContainer = async (): Promise<boolean> => {
    const existing = await engine.readContainer(name);

    requireOwnContainer(existing, options.container.labels);

    const action = pickHarnessStart(existing);

    if (action === 'replace') {
      await engine.removeContainer(name);
    }

    if (action === 'replace' || action === 'create') {
      await engine.createContainer(options.container);
    }

    if (action === 'unpause') {
      await engine.unpauseContainer(name);
    }

    if (action === 'replace' || action === 'create' || action === 'start') {
      await engine.startContainer(name);
    }

    return action === 'replace' || action === 'create' || action === 'start';
  };

  const run = async (): Promise<void> => {
    try {
      await options.relay.listening;

      if (isFinished) {
        return;
      }

      const created = await startContainer();

      if (isFinished) {
        return;
      }

      const attached = await engine.attachContainer(name, { stdin: true, logs: true });

      follow(attached);

      isRunning = true;

      if (isFinished) {
        return;
      }

      started.resolve({ created });

      await waitOut(engine.resizeContainer(name, size.cols, size.rows));

      if (isKillRequested) {
        await engine.killContainer(name, 'SIGTERM');
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);

      const refusal =
        error instanceof DaemonError
          ? error
          : new DaemonError(
              'host_unavailable',
              `docker container ${name} could not start the harness: ${detail}`,
              { provider: 'docker', problem: 'not_started' },
            );

      emitExit({ exitCode: 1, reason: 'ended', detail: `start failed (${detail})` }, refusal);
    }
  };

  void run();

  return {
    onData: (listener) => subscribe(dataListeners, listener),
    onExit: (listener) => subscribe(exitListeners, listener),
    onAttachment: (listener) => subscribe(attachmentListeners, listener),
    write: (data) => {
      const bytes = encoder.encode(data);

      if (attachment === null) {
        queuedInput.push(bytes);

        return;
      }

      void waitOut(attachment.write(bytes));
    },
    resize: (cols, rows) => {
      size = { cols, rows };

      if (isRunning) {
        void waitOut(engine.resizeContainer(name, cols, rows));
      }
    },
    kill: () => {
      isKillRequested = true;

      if (isRunning) {
        void waitOut(engine.killContainer(name, 'SIGTERM'));
      }
    },
    killForced: () => {
      isKillRequested = true;
      void waitOut(engine.killContainer(name, 'SIGKILL'));
    },
    waitForStart: () => started.promise,
    waitForExit: (timeoutMs) => {
      if (isFinished) {
        return Promise.resolve(hasExited);
      }

      const waiting = Promise.withResolvers<boolean>();

      const timer = setTimeout(() => {
        waiting.resolve(false);
      }, timeoutMs);

      exitWaiters.push((exited) => {
        clearTimeout(timer);

        waiting.resolve(exited);
      });

      return waiting.promise;
    },
    detach: () => {
      if (isFinished) {
        return;
      }

      finish();

      dataListeners.length = 0;
      exitListeners.length = 0;
      attachmentListeners.length = 0;

      for (const waiter of exitWaiters.splice(0)) {
        waiter(false);
      }
    },
  };
}

function subscribe<T>(listeners: T[], listener: T): { readonly dispose: () => void } {
  listeners.push(listener);

  return {
    dispose: () => {
      const index = listeners.indexOf(listener);

      if (index !== -1) {
        listeners.splice(index, 1);
      }
    },
  };
}
