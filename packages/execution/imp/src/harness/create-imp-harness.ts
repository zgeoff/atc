import type { HarnessExit, HarnessHandle, LaunchTicket } from '@atc/plugin-api';
import { DaemonError } from '@atc/protocol/wire';
import { P, match } from 'ts-pattern';
import type {
  ImpPort,
  ImpSessionConnection,
  ImpSessionHandlers,
  ImpSessionOutcome,
  ImpSessionRequest,
  ImpSessionStarted,
  PreviousGeneration,
} from '../port/imp-port';
import { buildLostExit } from './build-lost-exit';
import { buildPreconditionRefusal } from './build-precondition-refusal';
import { buildStateExit } from './build-state-exit';
import { createImpHarnessEvents } from './create-imp-harness-events';
import { createImpHarnessOutput } from './create-imp-harness-output';
import { createImpHarnessState } from './create-imp-harness-state';
import { formatOutcome } from './format-outcome';
import type { ImpHarnessHost } from './imp-harness-host';
import { makeConnectionGate } from './make-connection-gate';
import { waitForAdmission } from './wait-for-admission';

export interface ImpHarness extends HarnessHandle {
  readonly onAttachment: NonNullable<HarnessHandle['onAttachment']>;

  readonly waitForStart: NonNullable<HarnessHandle['waitForStart']>;
}

export function createImpHarness(
  port: ImpPort,
  start: ImpSessionRequest,
  host: ImpHarnessHost,
): ImpHarness {
  const name = start.name;
  const session = start.session;

  // impd checks requirements only on a start, since its exec protocol gives an attach none,
  // so the start and every reattach go through the host's admission before they are sent.
  const hasRequirements = start.kind === 'start' && (start.require?.length ?? 0) > 0;
  const state = createImpHarnessState();
  let connectionTicket: LaunchTicket | null = null;
  const events = createImpHarnessEvents();

  const output = createImpHarnessOutput((text) => {
    events.emitData(text);
  });

  let connection: ImpSessionConnection | null = null;
  let pending: Uint8Array[] = [];
  let cols = start.cols;
  let rows = start.rows;
  let failures = 0;

  // Connections in a row that a handler of ours ended. A start never clears
  // it, since the next start can fail the same way.
  let localErrors = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // Whether the first start impd answered made the process, or attached to
  // one it still ran; null until a start is answered.
  let created: boolean | null = null;
  let startRefusal: DaemonError | null = null;
  let requestedSize: { cols: number; rows: number } = { cols: 0, rows: 0 };

  const emitStartOutcome = (): void => {
    const outcome = state.findStartOutcome();

    if (outcome === null) {
      return;
    }

    events.emitStartOutcome(outcome, created ?? true);
  };

  const stopFollowing = (confirmed: boolean, refusal: Readonly<DaemonError>): void => {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);

      reconnectTimer = null;
    }

    state.send({ type: 'END', confirmed, refusal });

    emitStartOutcome();

    connection = null;
    connectionTicket?.release();
    connectionTicket = null;

    events.dispose(state.findExitConfirmation() ?? false);
  };

  const emitExit = (exit: HarnessExit): void => {
    const listeners = events.getExitListeners();

    stopFollowing(
      exit.reason === undefined || exit.reason === 'exited',
      startRefusal ??
        new DaemonError(
          'host_unavailable',
          `imp ${name} ended the harness before it started (${exit.detail ?? 'process exited'})`,
          { provider: 'imp', problem: 'not_started' },
        ),
    );

    try {
      for (const listener of listeners) {
        listener(exit);
      }
    } finally {
      host.onDone();
    }
  };

  // The host's binding refuses the launch before any request reaches impd, so the harness
  // exits here without telling impd anything.
  const applyAdmissionRefusal = (error: unknown): void => {
    const detail = error instanceof Error ? error.message : String(error);

    startRefusal =
      error instanceof DaemonError
        ? error
        : new DaemonError('internal', `imp ${name} could not admit the harness: ${detail}`);

    emitExit({ exitCode: 1, reason: 'ended', detail: `launch refused (${detail})` });
  };

  // A reconnect never wakes the imp: a sleeping imp answers that it sleeps,
  // and only a revive wakes it.
  const buildAttach = (): ImpSessionRequest => {
    const cursor = state.shouldReplaceScreen() ? null : output.findCursor();

    if (cursor === null) {
      state.send({ type: 'FRESH_REQUESTED' });
    }

    return {
      kind: 'attach',
      name,
      session,
      cols,
      rows,
      wake: false,
      ...(cursor === null
        ? {}
        : {
            resumeFrom: {
              executionGeneration: cursor.generation,
              offset: output.getHighWater(),
            },
          }),
    };
  };

  const openCheckedConnection = (request: ImpSessionRequest): void => {
    if (!hasRequirements) {
      openConnection(request);

      return;
    }

    void waitForAdmission(request.kind, {
      host,
      isDone: () => state.isDone(),
      openConnection: (ticket) => {
        openConnection(request, ticket);
      },
      applyAdmissionRefusal: (error) => {
        applyAdmissionRefusal(error);
      },
    });
  };

  const scheduleReconnect = (
    outcome: Exclude<ImpSessionOutcome, { kind: 'exit' }>,
    delay: number | null,
  ): void => {
    const wait = delay ?? host.reconnectDelaysMs[failures];

    if (wait === undefined) {
      emitExit({ exitCode: 1, reason: 'ended', detail: formatOutcome(outcome) });

      return;
    }

    if (delay === null) {
      failures += 1;
    }

    events.emitAttachment('reattaching');

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;

      if (!state.isDone()) {
        const next = state.hasSentStart() ? buildAttach() : { ...start, cols, rows };

        openCheckedConnection(next);
      }
    }, wait);

    reconnectTimer.unref();
  };

  // A handler that throws on every connection would reconnect without end,
  // so these failures take the host's delays on their own count and end the
  // harness once they run out.
  const applyLocalError = (outcome: Extract<ImpSessionOutcome, { kind: 'local_error' }>): void => {
    const delay = host.reconnectDelaysMs[localErrors];

    if (delay === undefined) {
      emitExit({ exitCode: 1, reason: 'ended', detail: formatOutcome(outcome) });

      return;
    }

    localErrors += 1;

    scheduleReconnect(outcome, delay);
  };

  // impd refuses to start a session whose broker is not ready.
  // impd's client and this harness both refuse an exec whose requirements impd would ignore.
  const applyPreconditionRefusal = (
    outcome: Extract<ImpSessionOutcome, { kind: 'failed' }>,
  ): void => {
    const refused = buildPreconditionRefusal(outcome, name);

    if (refused.refusal !== null) {
      startRefusal = refused.refusal;
    }

    emitExit(refused.exit);
  };

  const applyRefusal = (outcome: Extract<ImpSessionOutcome, { kind: 'failed' }>): void => {
    match(outcome.code)
      .with('INVALID_RESUME', () => {
        state.send({ type: 'FRESH_REQUESTED' });
        output.resetCursor();

        scheduleReconnect(outcome, 0);
      })
      .with('NO_SESSION', () => {
        emitExit(buildLostExit(outcome.data, output.findCursor()));
      })
      .with('INVALID_STATE', () => {
        emitExit(buildStateExit(outcome.data));
      })
      .with('PRECONDITION_FAILED', () => {
        applyPreconditionRefusal(outcome);
      })
      .otherwise(() => {
        emitExit({ exitCode: 1, reason: 'ended', detail: formatOutcome(outcome) });
      });
  };

  // impd closes with 1011 when it drops a send and detaches a slow client. Reconnect at once
  // after either, but only on a started connection: one dropped before impd answered counts
  // as a failed reconnect.
  const applyOutcome = (outcome: ImpSessionOutcome, wasStarted: boolean): void => {
    if (outcome.kind !== 'local_error') {
      localErrors = 0;
    }

    const dropDelay = wasStarted ? 0 : null;

    match(outcome)
      .with({ kind: 'local_error' }, (ended) => {
        applyLocalError(ended);
      })
      .with({ kind: 'exit' }, (ended) => {
        emitExit({ exitCode: ended.code ?? 1, reason: 'exited' });
      })
      .with({ kind: 'failed' }, (ended) => {
        applyRefusal(ended);
      })
      .with({ kind: P.union('unauthorized', 'bad_message') }, (ended) => {
        emitExit({ exitCode: 1, reason: 'ended', detail: formatOutcome(ended) });
      })
      .with({ kind: 'closed', closeCode: 1011 }, { kind: 'detached', reason: 'slow' }, (ended) => {
        scheduleReconnect(ended, dropDelay);
      })
      .with({ kind: P.union('closed', 'detached', 'unreachable') }, (ended) => {
        scheduleReconnect(ended, null);
      })
      .exhaustive();
  };

  const waitForOutcome = async (
    opened: ImpSessionConnection,
    ticket: LaunchTicket | null,
  ): Promise<void> => {
    const outcome = await opened.outcome;

    ticket?.release();

    if (connection !== opened || state.isDone() || host.isSuspending()) {
      return;
    }

    const wasStarted = state.isStarted();

    connection = null;

    state.send({ type: 'CONNECTION_ENDED' });

    applyOutcome(outcome, wasStarted);
  };

  // Bytes after a gap can start inside an escape sequence, so the screen
  // takes a fresh attach instead. The old connection stops counting first,
  // so its close is not taken for a drop.
  const restartFreshAttach = (opened: ImpSessionConnection): void => {
    connection = null;

    opened.close();
    state.send({ type: 'FRESH_REQUESTED' });

    openCheckedConnection(buildAttach());
  };

  // impd starts a new generation under the same session name when it replaces the process,
  // so a different generation means this harness ended. impd reports the old exit code
  // only when it kept it.
  const emitReplacedExit = (
    opened: ImpSessionConnection,
    previous: PreviousGeneration | undefined,
  ): void => {
    const exit: HarnessExit =
      previous !== undefined && previous.executionGeneration === output.findCursor()?.generation
        ? { exitCode: previous.exitCode ?? 1, reason: 'exited' }
        : { exitCode: 1, reason: 'ended', detail: 'imp replaced the process' };

    connection = null;

    opened.close();

    emitExit(exit);
  };

  const applyStarted = (opened: ImpSessionConnection, started: ImpSessionStarted): void => {
    const startedOutput = started.output;
    const offsets = startedOutput.continuity === 'offsets' ? startedOutput : null;

    if (offsets?.resume?.kind === 'gap') {
      restartFreshAttach(opened);

      return;
    }

    if (offsets?.resume?.kind === 'generation_changed') {
      emitReplacedExit(opened, offsets.previous);

      return;
    }

    output.applyStart(offsets, state.shouldReplaceScreen());

    failures = 0;

    // The started event clears the pending kill, so read it first and send the kill
    // after the buffered input.
    const hasKill = state.hasPendingKill();

    created ??= started.created;

    state.send({ type: 'CONNECTION_STARTED' });

    emitStartOutcome();

    events.emitAttachment('attached');

    // impd drops a resize that reaches it before the session starts, so any size change
    // asked for after the start request went out is sent again here.
    if (requestedSize.cols !== cols || requestedSize.rows !== rows) {
      opened.resize(cols, rows);
    }

    for (const bytes of pending) {
      opened.write(bytes);
    }

    pending = [];

    if (hasKill) {
      opened.sendSignal('SIGHUP');
    }
  };

  const openConnection = (request: ImpSessionRequest, ticket?: LaunchTicket): void => {
    const gate = makeConnectionGate(request, ticket, {
      name,
      state,
      applyTicketRefusal: (refusal) => {
        connection = null;

        applyAdmissionRefusal(refusal);
      },
    });

    const handlers: ImpSessionHandlers = {
      onStarted: (started) => {
        if (connection === opened) {
          applyStarted(opened, started);
        }
      },
      onOutput: (data) => {
        if (connection === opened) {
          output.applyOutput(data);
        }
      },
    };

    let opened: ImpSessionConnection;

    try {
      opened = port.openSession(request, handlers, gate);
    } catch (error) {
      ticket?.release();
      throw error;
    }

    connection = opened;
    connectionTicket = ticket ?? null;

    state.send({ type: 'CONNECTION_OPENED' });

    requestedSize = { cols: request.cols, rows: request.rows };
    void waitForOutcome(opened, ticket ?? null);
  };

  const startWhenReady = async (ready: Promise<void>): Promise<void> => {
    try {
      await ready;
    } catch (error) {
      if (!state.isDone()) {
        emitExit({
          exitCode: 1,
          reason: 'ended',
          detail: `imp refused the report socket (${error instanceof Error ? error.message : String(error)})`,
        });
      }

      return;
    }

    // The terminal can resize while the host gets ready, so send the current size rather than
    // the size captured when the start was requested.
    if (!state.isDone()) {
      openCheckedConnection({ ...start, cols, rows });
    }
  };

  if (host.ready === undefined) {
    openCheckedConnection(start);
  } else {
    void startWhenReady(host.ready);
  }

  return {
    onData: events.onData,

    onExit: events.onExit,

    onAttachment: events.onAttachment,

    write: (data) => {
      const bytes = new TextEncoder().encode(data);

      if (state.isStarted() && connection !== null) {
        connection.write(bytes);
      } else if (!state.isDone()) {
        pending.push(bytes);
      }
    },

    resize: (nextCols, nextRows) => {
      cols = nextCols;
      rows = nextRows;
      connection?.resize(nextCols, nextRows);
    },

    kill: () => {
      if (state.isStarted() && connection !== null) {
        connection.sendSignal('SIGHUP');
      } else {
        state.send({ type: 'KILL_REQUESTED' });
      }
    },

    // Only an exit impd reports counts: a host that lost the process or went
    // to sleep with it inside confirms nothing.
    waitForExit: (timeoutMs) => {
      const confirmed = state.findExitConfirmation();

      if (confirmed !== null) {
        return Promise.resolve(confirmed);
      }

      return events.waitForExit(timeoutMs);
    },

    waitForStart: () => {
      const outcome = state.findStartOutcome();

      if (outcome === 'started') {
        return Promise.resolve({ created: created ?? true });
      }

      if (outcome !== null) {
        return Promise.reject(outcome);
      }

      return events.waitForStart();
    },

    detach: () => {
      if (state.isDone()) {
        return;
      }

      const opened = connection;

      stopFollowing(
        false,
        new DaemonError(
          'host_unavailable',
          `the daemon let go of imp ${name}'s harness before it started`,
          { provider: 'imp', problem: 'not_started' },
        ),
      );

      opened?.close();
      host.onDone();
    },
  };
}
