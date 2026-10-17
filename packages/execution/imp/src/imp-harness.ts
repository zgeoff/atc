import type { HarnessExit, HarnessHandle, HarnessStart, LaunchTicket } from '@atc/plugin-api';
import { DaemonError } from '@atc/protocol/wire';
import { P, match } from 'ts-pattern';
import { buildLostExit } from './build-lost-exit';
import { buildPreconditionRefusal } from './build-precondition-refusal';
import { buildStateExit } from './build-state-exit';
import { formatOutcome } from './format-outcome';
import { ImpHarnessEvents } from './imp-harness-events';
import type { ImpHarnessHost } from './imp-harness-host';
import { ImpHarnessOutput } from './imp-harness-output';
import { ImpHarnessState } from './imp-harness-state';
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

export class ImpHarness implements HarnessHandle {
  private readonly port: ImpPort;

  private readonly host: ImpHarnessHost;

  private readonly name: string;

  private readonly session: string;

  // Whether the start lists requirements. impd checks them on the start
  // alone, since its exec protocol gives an attach none, so the start and
  // every reattach pass the host's admission before they go out.
  private readonly hasRequirements: boolean;

  // The request that starts the process. Until it goes out to impd, a retry
  // sends it again, since there is no process to attach to.
  private readonly start: ImpSessionRequest;

  private readonly state = new ImpHarnessState();

  // The admission of the open connection's request, while it has one.
  private connectionTicket: LaunchTicket | null = null;

  private readonly events = new ImpHarnessEvents();

  private readonly output = new ImpHarnessOutput((text) => {
    this.events.emitData(text);
  });

  private connection: ImpSessionConnection | null = null;

  private pending: Uint8Array[] = [];

  private cols: number;

  private rows: number;

  private failures = 0;

  // Connections in a row that a handler of ours ended. A start never clears
  // it, since the next start can fail the same way.
  private localErrors = 0;

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // Whether the first start impd answered made the process, or attached to
  // one it still ran; null until a start is answered.
  private created: boolean | null = null;

  // Why impd refused to start the harness, once it has given a reason.
  private startRefusal: DaemonError | null = null;

  // The terminal size the open connection's request asked for.
  private requestedSize: { cols: number; rows: number } = { cols: 0, rows: 0 };

  constructor(port: ImpPort, start: ImpSessionRequest, host: ImpHarnessHost) {
    this.port = port;
    this.host = host;
    this.name = start.name;
    this.session = start.session;
    this.hasRequirements = start.kind === 'start' && (start.require?.length ?? 0) > 0;
    this.start = start;
    this.cols = start.cols;
    this.rows = start.rows;

    if (host.ready === undefined) {
      this.openCheckedConnection(start);
    } else {
      void this.startWhenReady(host.ready, start);
    }
  }

  readonly onData = this.events.onData;

  readonly onExit = this.events.onExit;

  readonly onAttachment = this.events.onAttachment;

  readonly write = (data: string): void => {
    const bytes = new TextEncoder().encode(data);

    if (this.state.isStarted() && this.connection !== null) {
      this.connection.write(bytes);
    } else if (!this.state.isDone()) {
      this.pending.push(bytes);
    }
  };

  readonly resize = (cols: number, rows: number): void => {
    this.cols = cols;
    this.rows = rows;
    this.connection?.resize(cols, rows);
  };

  // A kill between connections goes out once the next one starts.
  readonly kill = (): void => {
    if (this.state.isStarted() && this.connection !== null) {
      this.connection.sendSignal('SIGHUP');
    } else {
      this.state.send({ type: 'KILL_REQUESTED' });
    }
  };

  // Only an exit impd reports counts: a host that lost the process or went
  // to sleep with it inside confirms nothing.
  readonly waitForExit = (timeoutMs: number): Promise<boolean> => {
    const confirmed = this.state.getExitConfirmation();

    if (confirmed !== null) {
      return Promise.resolve(confirmed);
    }

    return this.events.waitForExit(timeoutMs);
  };

  readonly waitForStart = (): Promise<HarnessStart> => {
    const outcome = this.state.getStartOutcome();

    if (outcome === 'started') {
      return Promise.resolve({ created: this.created ?? true });
    }

    if (outcome !== null) {
      return Promise.reject(outcome);
    }

    return this.events.waitForStart();
  };

  readonly detach = (): void => {
    if (this.state.isDone()) {
      return;
    }

    const connection = this.connection;

    this.stopFollowing(
      false,
      new DaemonError(
        'host_unavailable',
        `the daemon let go of imp ${this.name}'s harness before it started`,
        { provider: 'imp', problem: 'not_started' },
      ),
    );

    connection?.close();
    this.host.onDone();
  };

  private async startWhenReady(ready: Promise<void>, start: ImpSessionRequest): Promise<void> {
    try {
      await ready;
    } catch (error) {
      if (!this.state.isDone()) {
        this.emitExit({
          exitCode: 1,
          reason: 'ended',
          detail: `imp refused the report socket (${error instanceof Error ? error.message : String(error)})`,
        });
      }

      return;
    }

    // A resize while the host readied changed the size the start asks for.
    if (!this.state.isDone()) {
      this.openCheckedConnection({ ...start, cols: this.cols, rows: this.rows });
    }
  }

  // An impd from before exec requirements ignores them and runs the command
  // anyway, so a start or reattach that has any waits until impd shows it
  // honours them and the host admits it.
  private openCheckedConnection(request: ImpSessionRequest): void {
    if (!this.hasRequirements) {
      this.openConnection(request);

      return;
    }

    void waitForAdmission(request.kind, {
      port: this.port,
      host: this.host,
      name: this.name,
      isDone: () => this.state.isDone(),
      applyOutcome: (outcome) => {
        this.applyOutcome(outcome, false);
      },
      openConnection: (ticket) => {
        this.openConnection(request, ticket);
      },
      applyAdmissionRefusal: (error) => {
        this.applyAdmissionRefusal(error);
      },
    });
  }

  // A launch the host's binding no longer admits ends the harness with
  // that refusal; nothing went out to impd.
  private applyAdmissionRefusal(error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);

    this.startRefusal =
      error instanceof DaemonError
        ? error
        : new DaemonError('internal', `imp ${this.name} could not admit the harness: ${detail}`);

    this.emitExit({ exitCode: 1, reason: 'ended', detail: `launch refused (${detail})` });
  }

  // A start counts as sent only once the gate runs, and with a ticket only once
  // its check passes. The ticket goes back whenever the connection ends or the
  // harness lets go of it.
  private openConnection(request: ImpSessionRequest, ticket?: LaunchTicket): void {
    const gate = makeConnectionGate(request, ticket, {
      name: this.name,
      state: this.state,
      applyTicketRefusal: (refusal) => {
        this.connection = null;

        this.applyAdmissionRefusal(refusal);
      },
    });

    const handlers: ImpSessionHandlers = {
      onStarted: (started) => {
        if (this.connection === connection) {
          this.applyStarted(connection, started);
        }
      },
      onOutput: (data) => {
        if (this.connection === connection) {
          this.output.applyOutput(data);
        }
      },
    };

    let connection: ImpSessionConnection;

    // The ticket goes back however the connection ends, a throw from
    // opening it included.
    try {
      connection = this.port.openSession(request, handlers, gate);
    } catch (error) {
      ticket?.release();
      throw error;
    }

    this.connection = connection;
    this.connectionTicket = ticket ?? null;

    this.state.send({ type: 'CONNECTION_OPENED' });

    this.requestedSize = { cols: request.cols, rows: request.rows };
    void this.waitForOutcome(connection, ticket ?? null);
  }

  private applyStarted(connection: ImpSessionConnection, started: ImpSessionStarted): void {
    const output = started.output;
    const offsets = this.host.offsets && output.continuity === 'offsets' ? output : null;

    if (offsets?.resume?.kind === 'gap') {
      this.restartFreshAttach(connection);

      return;
    }

    if (offsets?.resume?.kind === 'generation_changed') {
      this.emitReplacedExit(connection, offsets.previous);

      return;
    }

    this.output.applyStart(offsets, this.state.needsFreshScreen());

    this.failures = 0;

    // A start resumes the screen and takes the waiting kill with it.
    const hasKill = this.state.hasPendingKill();

    this.created ??= started.created;

    this.state.send({ type: 'CONNECTION_STARTED' });
    this.emitStartOutcome();
    this.events.emitAttachment('attached');

    // impd drops a resize that reaches it before the session starts, so the
    // size asked for since the request goes out now.
    if (this.requestedSize.cols !== this.cols || this.requestedSize.rows !== this.rows) {
      connection.resize(this.cols, this.rows);
    }

    for (const bytes of this.pending) {
      connection.write(bytes);
    }

    this.pending = [];

    if (hasKill) {
      connection.sendSignal('SIGHUP');
    }
  }

  private async waitForOutcome(
    connection: ImpSessionConnection,
    ticket: LaunchTicket | null,
  ): Promise<void> {
    const outcome = await connection.outcome;

    ticket?.release();

    if (this.connection !== connection || this.state.isDone() || this.host.isSuspending()) {
      return;
    }

    const wasStarted = this.state.isStarted();

    this.connection = null;

    this.state.send({ type: 'CONNECTION_ENDED' });
    this.applyOutcome(outcome, wasStarted);
  }

  // impd closes a connection whose send it dropped with 1011, and detaches a slow
  // one. Either resumes at once, a drop only on a started connection, so one
  // dropped before impd answers counts as a failed reconnect.
  private applyOutcome(outcome: ImpSessionOutcome, wasStarted: boolean): void {
    if (outcome.kind !== 'local_error') {
      this.localErrors = 0;
    }

    const dropDelay = wasStarted ? 0 : null;

    match(outcome)
      .with({ kind: 'local_error' }, (ended) => {
        this.applyLocalError(ended);
      })
      .with({ kind: 'exit' }, (ended) => {
        this.emitExit({ exitCode: ended.code ?? 1, reason: 'exited' });
      })
      .with({ kind: 'failed' }, (ended) => {
        this.applyRefusal(ended);
      })
      .with({ kind: P.union('unauthorized', 'bad_message') }, (ended) => {
        this.emitExit({ exitCode: 1, reason: 'ended', detail: formatOutcome(ended) });
      })
      .with({ kind: 'closed', closeCode: 1011 }, { kind: 'detached', reason: 'slow' }, (ended) => {
        this.scheduleReconnect(ended, dropDelay);
      })
      .with({ kind: P.union('closed', 'detached', 'unreachable') }, (ended) => {
        this.scheduleReconnect(ended, null);
      })
      .exhaustive();
  }

  // A handler that throws on every connection would reconnect without end,
  // so these failures take the host's delays on their own count and end the
  // harness once they run out.
  private applyLocalError(outcome: Extract<ImpSessionOutcome, { kind: 'local_error' }>): void {
    const delay = this.host.reconnectDelaysMs[this.localErrors];

    if (delay === undefined) {
      this.emitExit({ exitCode: 1, reason: 'ended', detail: formatOutcome(outcome) });

      return;
    }

    this.localErrors += 1;

    this.scheduleReconnect(outcome, delay);
  }

  private applyRefusal(outcome: Extract<ImpSessionOutcome, { kind: 'failed' }>): void {
    match(outcome.code)
      .with('INVALID_RESUME', () => {
        this.state.send({ type: 'FRESH_REQUESTED' });
        this.output.resetCursor();
        this.scheduleReconnect(outcome, 0);
      })
      .with('NO_SESSION', () => {
        this.emitExit(buildLostExit(outcome.data, this.output.getCursor()));
      })
      .with('INVALID_STATE', () => {
        this.emitExit(buildStateExit(outcome.data));
      })
      .with('PRECONDITION_FAILED', () => {
        this.applyPreconditionRefusal(outcome);
      })
      .otherwise(() => {
        this.emitExit({ exitCode: 1, reason: 'ended', detail: formatOutcome(outcome) });
      });
  }

  // impd refuses a start whose broker is not ready. An exec with
  // requirements is refused against an impd that would ignore them, by
  // impd's client and the harness both.
  private applyPreconditionRefusal(outcome: Extract<ImpSessionOutcome, { kind: 'failed' }>): void {
    const refused = buildPreconditionRefusal(outcome, this.name);

    if (refused.refusal !== null) {
      this.startRefusal = refused.refusal;
    }

    this.emitExit(refused.exit);
  }

  // A delay of null takes the next one from the host's list; running out of
  // them ends the harness with what ended its last connection.
  private scheduleReconnect(
    outcome: Exclude<ImpSessionOutcome, { kind: 'exit' }>,
    delay: number | null,
  ): void {
    const wait = delay ?? this.host.reconnectDelaysMs[this.failures];

    if (wait === undefined) {
      this.emitExit({ exitCode: 1, reason: 'ended', detail: formatOutcome(outcome) });

      return;
    }

    if (delay === null) {
      this.failures += 1;
    }

    this.events.emitAttachment('reattaching');

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;

      if (!this.state.isDone()) {
        const next = this.state.hasSentStart()
          ? this.buildAttach()
          : { ...this.start, cols: this.cols, rows: this.rows };

        this.openCheckedConnection(next);
      }
    }, wait);

    this.reconnectTimer.unref();
  }

  // A reconnect never wakes the imp: a sleeping imp answers that it sleeps,
  // and only a revive wakes it.
  private buildAttach(): ImpSessionRequest {
    const cursor = this.state.needsFreshScreen() ? null : this.output.getCursor();

    if (cursor === null) {
      this.state.send({ type: 'FRESH_REQUESTED' });
    }

    return {
      kind: 'attach',
      name: this.name,
      session: this.session,
      cols: this.cols,
      rows: this.rows,
      wake: false,
      ...(cursor === null
        ? {}
        : {
            resumeFrom: {
              executionGeneration: cursor.generation,
              offset: this.output.getHighWater(),
            },
          }),
    };
  }

  // Bytes after a gap can start inside an escape sequence, so the screen
  // takes a fresh attach instead. The old connection stops counting first,
  // so its close is not taken for a drop.
  private restartFreshAttach(connection: ImpSessionConnection): void {
    this.connection = null;

    connection.close();
    this.state.send({ type: 'FRESH_REQUESTED' });
    this.openCheckedConnection(this.buildAttach());
  }

  // A generation under the session's name other than its own is not the
  // daemon's harness: the harness ended, with its exit code when impd kept
  // it.
  private emitReplacedExit(
    connection: ImpSessionConnection,
    previous: PreviousGeneration | undefined,
  ): void {
    const exit: HarnessExit =
      previous !== undefined && previous.executionGeneration === this.output.getCursor()?.generation
        ? { exitCode: previous.exitCode ?? 1, reason: 'exited' }
        : { exitCode: 1, reason: 'ended', detail: 'imp replaced the process' };

    this.connection = null;

    connection.close();
    this.emitExit(exit);
  }

  private emitExit(exit: HarnessExit): void {
    const listeners = this.events.getExitListeners();

    this.stopFollowing(
      exit.reason === undefined || exit.reason === 'exited',
      this.startRefusal ??
        new DaemonError(
          'host_unavailable',
          `imp ${this.name} ended the harness before it started (${exit.detail ?? 'process exited'})`,
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
      this.host.onDone();
    }
  }

  // The first end counts: it confirms the exit or leaves it unconfirmed,
  // settles a start that has not started with the refusal, and settles
  // every wait.
  private stopFollowing(confirmed: boolean, refusal: Readonly<DaemonError>): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);

      this.reconnectTimer = null;
    }

    this.state.send({ type: 'END', confirmed, refusal });
    this.emitStartOutcome();

    this.connection = null;
    this.connectionTicket?.release();
    this.connectionTicket = null;

    this.events.dispose(this.state.getExitConfirmation() ?? false);
  }

  // Each wait on the start settles once the start has settled.
  private emitStartOutcome(): void {
    const outcome = this.state.getStartOutcome();

    if (outcome === null) {
      return;
    }

    this.events.emitStartOutcome(outcome, this.created ?? true);
  }
}
