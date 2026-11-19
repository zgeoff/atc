import { setTimeout as sleep } from 'node:timers/promises';
import type {
  HarnessAttachment,
  HarnessExit,
  HarnessHandle,
  HarnessStart,
  OpenedRelay,
} from '@atc/plugin-api';
import type { DaemonError } from '@atc/protocol/wire';
import type { ExecConnection, ExecRequest, SpritesPort } from '../port/types';
import { waitOut } from '../port/wait-out';
import type { GuestRecords } from './create-guest-records';
import { toSpritesRefusal } from './to-sprites-refusal';

interface SpritesHarnessOptions {
  readonly api: SpritesPort;
  readonly records: GuestRecords;
  readonly sprite: string;
  readonly session: string;

  // the terminal exec to start when the sprite holds no harness to attach to
  readonly start: Omit<ExecRequest, 'tty'> & { readonly cols: number; readonly rows: number };
  readonly relay: OpenedRelay;
  readonly reconnectDelaysMs: readonly number[];
  readonly log: (line: string) => void;

  // runs once the harness has exited or been detached
  readonly onDone: () => void;
}

export interface SpritesHarness extends HarnessHandle {
  readonly onAttachment: NonNullable<HarnessHandle['onAttachment']>;
  readonly waitForStart: NonNullable<HarnessHandle['waitForStart']>;
  readonly killForced: NonNullable<HarnessHandle['killForced']>;
}

// Follows the harness of a session in a terminal exec. It attaches to the exec the guest folder
// records when the sprite still holds it under the same boot, and otherwise starts the spec's
// command, which a revive sets to the resume command. A failed start arrives as an exit.
export function createSpritesHarness(options: SpritesHarnessOptions): SpritesHarness {
  const api = options.api;

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  const dataListeners: ((data: string) => void)[] = [];
  const exitListeners: ((exit: HarnessExit) => void)[] = [];
  const attachmentListeners: ((attachment: HarnessAttachment) => void)[] = [];
  const exitWaiters: ((exited: boolean) => void)[] = [];
  const started = Promise.withResolvers<HarnessStart>();

  // an unawaited rejection never crashes the daemon
  void waitOut(started.promise);
  let connection: ExecConnection | null = null;
  let execID: string | null = null;
  let isFinished = false;
  let hasExited = false;
  let isRestoring = false;
  let isKillRequested: 'SIGTERM' | 'SIGKILL' | null = null;
  let size = { cols: options.start.cols, rows: options.start.rows };
  const queuedInput: Uint8Array[] = [];

  const finish = (): void => {
    isFinished = true;

    options.relay.stop();
    connection?.detach();
    connection = null;

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
        toSpritesRefusal(
          new Error(`the harness of session ${options.session} ended before it started`),
        ),
    );

    for (const listener of exitListeners) {
      listener(exit);
    }

    for (const waiter of exitWaiters.splice(0)) {
      waiter(true);
    }
  };

  const emitAttachment = (state: HarnessAttachment): void => {
    for (const listener of attachmentListeners) {
      listener(state);
    }
  };

  const follow = (next: ExecConnection): void => {
    connection = next;
    void waitOut(next.execID);

    next.onData((data) => {
      const text = decoder.decode(data, { stream: true });

      for (const listener of dataListeners) {
        listener(text);
      }
    });

    next.onEnd((end) => {
      if (connection !== next || isFinished) {
        return;
      }

      if (end.kind === 'exit') {
        emitExit({ exitCode: end.exitCode, reason: 'exited' });

        return;
      }

      void restoreAttach();
    });

    for (const chunk of queuedInput.splice(0)) {
      void waitOut(next.write(chunk));
    }

    void announce(next);
  };

  // the exec takes a resize or a signal only once it has announced itself
  const announce = async (next: ExecConnection): Promise<void> => {
    await waitOut(next.execID);

    next.resize(size.cols, size.rows);

    if (isKillRequested !== null) {
      next.signal(isKillRequested);
    }
  };

  // A connection that ended while the exec still stands attaches again, and the API replays the
  // screen. An exec the sprite no longer lists is the harness's end.
  // One loop at a time: a failed attach ends its connection, which asks for another loop.
  const restoreAttach = async (): Promise<void> => {
    if (isRestoring) {
      return;
    }

    isRestoring = true;

    try {
      await retryAttach();
    } finally {
      isRestoring = false;
    }
  };

  const retryAttach = async (): Promise<void> => {
    emitAttachment('reattaching');

    for (let attempt = 0; attempt <= options.reconnectDelaysMs.length; attempt += 1) {
      try {
        const reason = await readLoss();

        if (isFinished) {
          return;
        }

        if (reason !== null) {
          emitExit({ exitCode: 1, reason: 'ended', detail: reason });

          return;
        }

        const reattached = api.openExec(options.sprite, {
          execID: execID ?? '',
          argv: [],
          tty: true,
        });

        follow(reattached);

        await reattached.execID;

        emitAttachment('attached');

        return;
      } catch (error) {
        options.log(
          `sprites harness ${options.session} could not reattach (${error instanceof Error ? error.message : String(error)})`,
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

    emitExit({ exitCode: 1, reason: 'ended', detail: 'the harness cannot be reattached' });
  };

  // why the sprite no longer runs the harness, or null while it does
  const readLoss = async (): Promise<string | null> => {
    if ((await api.readSprite(options.sprite)) === null) {
      return 'the sprite is gone';
    }

    const execs = await api.listExecs(options.sprite);

    return execs.some((exec) => exec.id === execID) ? null : 'the harness exec is gone';
  };

  const run = async (): Promise<void> => {
    try {
      await options.relay.listening;

      if (isFinished) {
        return;
      }

      const boot = await options.records.readBootID(options.sprite);
      const record = await options.records.readSessionRecord(options.sprite, options.session);
      const execs = await api.listExecs(options.sprite);

      if (isFinished) {
        return;
      }

      const recorded = record?.harness ?? null;

      // an exec id from another boot can name a different exec
      const kept =
        recorded !== null &&
        recorded.boot === boot &&
        execs.some((exec) => exec.id === recorded.exec && exec.tty)
          ? recorded
          : null;

      const next =
        kept === null
          ? api.openExec(options.sprite, { ...options.start, tty: true, ...size })
          : api.openExec(options.sprite, { execID: kept.exec, argv: [], tty: true });

      follow(next);

      execID = await next.execID;

      if (kept === null) {
        await options.records.updateSessionRecord(options.sprite, options.session, (current) => ({
          ...current,
          harness: { exec: execID ?? '', boot },
        }));
      }

      if (isFinished) {
        return;
      }

      started.resolve({ created: kept === null });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);

      emitExit(
        { exitCode: 1, reason: 'ended', detail: `start failed (${detail})` },
        toSpritesRefusal(error),
      );
    }
  };

  void run();

  return {
    onData: (listener) => subscribe(dataListeners, listener),
    onExit: (listener) => subscribe(exitListeners, listener),
    onAttachment: (listener) => subscribe(attachmentListeners, listener),
    write: (data) => {
      const bytes = encoder.encode(data);

      if (connection === null) {
        queuedInput.push(bytes);

        return;
      }

      void waitOut(connection.write(bytes));
    },
    resize: (cols, rows) => {
      size = { cols, rows };
      connection?.resize(cols, rows);
    },
    kill: () => {
      isKillRequested = 'SIGTERM';
      connection?.signal('SIGTERM');
    },
    killForced: () => {
      isKillRequested = 'SIGKILL';
      connection?.signal('SIGKILL');
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
