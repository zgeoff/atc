import type { HarnessExit, HarnessHandle, LaunchTicket } from '@atc/plugin-api';
import { DaemonError } from '@atc/protocol/wire';
import { P, match } from 'ts-pattern';
import { buildLostExit } from './build-lost-exit';
import { buildPreconditionRefusal } from './build-precondition-refusal';
import { buildStateExit } from './build-state-exit';
import { createImpHarnessEvents } from './create-imp-harness-events';
import { createImpHarnessOutput } from './create-imp-harness-output';
import { createImpHarnessState } from './create-imp-harness-state';
import { formatOutcome } from './format-outcome';
import type { ImpHarnessHost } from './imp-harness-host';
import type {
  ImpPort,
  ImpSessionConnection,
  ImpSessionHandlers,
  ImpSessionOutcome,
  ImpSessionRequest,
  ImpSessionStarted,
  PreviousGeneration,
} from './imp-port';
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

  // Whether the start lists requirements. impd checks them on the start
  // alone, since its exec protocol gives an attach none, so the start and
  // every reattach pass the host's admission before they go out.
  const hasRequirements = start.kind === 'start' && (start.require?.length ?? 0) > 0;
  const state = createImpHarnessState();

  // The admission of the open connection's request, while it has one.
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

  // Why impd refused to start the harness, once it has given a reason.
  let startRefusal: DaemonError | null = null;

  // The terminal size the open connection's request asked for.
  let requestedSize: { cols: number; rows: number } = { cols: 0, rows: 0 };

  // Each wait on the start settles once the start has settled.
  const emitStartOutcome = (): void => {
    const outcome = state.findStartOutcome();

    if (outcome === null) {
      return;
    }

    events.emitStartOutcome(outcome, created ?? true);
  };

  // The first end counts: it confirms the exit or leaves it unconfirmed,
  // settles a start that has not started with the refusal, and settles
  // every wait.
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

    // The host hears the harness is done only after every exit listener
    // has run, so its owner no longer counts the harness as running then.
    try {
      for (const listener of listeners) {
        listener(exit);
      }
    } finally {
      host.onDone();
    }
  };

  // A launch the host's binding no longer admits ends the harness with
  // that refusal; nothing went out to impd.
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

  // A start or reattach that has requirements waits until the host admits it.
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

  // A delay of null takes the next one from the host's list; running out of
  // them ends the harness with what ended its last connection.
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

  // impd refuses a start whose broker is not ready. An exec with
  // requirements is refused against an impd that would ignore them, by
  // impd's client and the harness both.
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

  // impd closes a connection whose send it dropped with 1011, and detaches a slow
  // one. Either resumes at once, a drop only on a started connection, so one
  // dropped before impd answers counts as a failed reconnect.
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

  // A generation under the session's name other than its own is not the
  // daemon's harness: the harness ended, with its exit code when impd kept
  // it.
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

    // A start resumes the screen and takes the waiting kill with it.
    const hasKill = state.hasPendingKill();

    created ??= started.created;

    state.send({ type: 'CONNECTION_STARTED' });

    emitStartOutcome();

    events.emitAttachment('attached');

    // impd drops a resize that reaches it before the session starts, so the
    // size asked for since the request goes out now.
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

  // A start counts as sent only once the gate runs, and with a ticket only once
  // its check passes. The ticket goes back whenever the connection ends or the
  // harness lets go of it.
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

    // The ticket goes back however the connection ends, a throw from
    // opening it included.
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

    // A resize while the host readied changed the size the start asks for.
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

    // A kill between connections goes out once the next one starts.
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
