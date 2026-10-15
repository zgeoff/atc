import { ansi, truncateSummary } from '@atc/core';
import type {
  HarnessAttachment,
  HarnessExit,
  HarnessHandle,
  HarnessStart,
  LaunchTicket,
} from '@atc/plugin-api';
import { DaemonError } from '@atc/protocol/wire';
import { P, match } from 'ts-pattern';
import { createActor } from 'xstate';
import { z } from 'zod';
import { IMP_HARNESS_MACHINE } from './imp-harness-machine';
import type {
  ImpExecRequirement,
  ImpPort,
  ImpSessionConnection,
  ImpSessionHandlers,
  ImpSessionOutcome,
  ImpSessionRequest,
  ImpSessionStarted,
  PreviousGeneration,
} from './imp-port';
import { sanitizeDetail } from './sanitize-detail';

// What the harness asks of the provider that started it.
interface ImpHarnessHost {
  // Whether the provider is putting the harness's host to sleep, so a
  // connection the sleep ends is the sleep's and not the harness's end.
  readonly isSuspending: () => boolean;

  // Called once, when the harness ends or the daemon lets go of it; for an
  // end, after every exit listener has run.
  readonly onDone: () => void;

  // Whether impd carries output offsets, so a reconnect can resume.
  readonly offsets: boolean;

  // The wait before each reconnect after a connection ends without an
  // exit; the harness ends once they run out.
  readonly reconnectDelaysMs: readonly number[];

  // Settles once the harness may start, such as when its report socket
  // listens; a rejection ends the harness before it starts.
  readonly ready?: Promise<void>;

  // Admits each request that has requirements by calling send, or rejects
  // with the refusal that ends the harness, sending nothing. The ticket
  // send gets is checked just before the request goes out, and a refusal
  // from it ends the harness with nothing sent.
  readonly admit?: (
    kind: 'start' | 'attach',
    send: (ticket: LaunchTicket) => void,
  ) => Promise<void>;
}

// The bytes a fresh attach sends listeners ahead of its replay: reset the
// attributes, home the cursor, and clear the screen. A full terminal reset
// would also undo the modes of every attached client's own terminal.
const SCREEN_RESET = `${ansi.reset}${ansi.cursorHome}${ansi.eraseScreen}`;

/**
 * A harness running in an imp session, as the daemon's one connection to
 * it. Input written before the session starts waits for it. A kill sends
 * the process SIGHUP, as closing a terminal does; a detach closes the
 * connection and leaves the process running under its session name.
 *
 * A connection that ends without an exit reconnects without waking the
 * imp. Where impd carries offsets, a reconnect resumes after the last byte
 * the daemon has and drops any byte below it; a gap, or an imp without
 * offsets, gets a fresh attach that clears the screen before its replay.
 */
export class ImpHarness implements HarnessHandle {
  private readonly port: ImpPort;

  private readonly host: ImpHarnessHost;

  private readonly name: string;

  private readonly session: string;

  // What impd must have ready before the start and every reattach, so an
  // attach never joins the process past a requirement the start had.
  private readonly require: readonly ImpExecRequirement[] | undefined;

  // The request that starts the process. Until it goes out to impd, a retry
  // sends it again, since there is no process to attach to.
  private readonly start: ImpSessionRequest;

  // Whether the open connection started, whether the start went out, how
  // the next connection meets the screen, whether a kill waits, whether the
  // harness ended, and how its start settled.
  private readonly state = createActor(IMP_HARNESS_MACHINE).start();

  // The admission of the open connection's request, while it has one.
  private connectionTicket: LaunchTicket | null = null;

  private readonly dataListeners = new Set<(data: string) => void>();

  private readonly exitListeners = new Set<(exit: HarnessExit) => void>();

  private readonly attachmentListeners = new Set<(attachment: HarnessAttachment) => void>();

  private decoder = new TextDecoder();

  private connection: ImpSessionConnection | null = null;

  private pending: Uint8Array[] = [];

  private cols: number;

  private rows: number;

  // The boot and generation the daemon's output came from, while impd
  // carries offsets for the session.
  private cursor: { readonly bootId: string; readonly generation: string } | null = null;

  // The offset after the last byte the daemon has, the offset the current
  // connection's next byte sits at, and the mode bytes still owed before
  // it, which have no offset.
  private highWater = 0;

  private nextOffset = 0;

  private preludeLeft = 0;

  private failures = 0;

  // Connections in a row that a handler of ours ended. A start never clears
  // it, since the next start can fail the same way.
  private localErrors = 0;

  // The waits on whether the process exited, until the harness stops being
  // followed.
  private readonly exitWaiters = new Set<{
    readonly waited: PromiseWithResolvers<boolean>;
    readonly timer: ReturnType<typeof setTimeout>;
  }>();

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // The waits on how the harness's start settles: started once a connection
  // first starts the process or attaches to it, or the refusal it ended
  // with before that.
  private readonly startWaiters = new Set<PromiseWithResolvers<HarnessStart>>();

  // Whether the first start impd answered made the process, or attached to
  // one it still ran; null until a start is answered.
  private created: boolean | null = null;

  // Why impd refused to start the harness, once it has given a reason.
  private startRefusal: DaemonError | null = null;

  // The terminal size the open connection's request asked for.
  private requestedSize: { cols: number; rows: number } = { cols: 0, rows: 0 };

  // oxlint-disable-next-line prefer-readonly-parameter-types -- the host holds a live promise
  constructor(port: ImpPort, start: ImpSessionRequest, host: ImpHarnessHost) {
    this.port = port;
    this.host = host;
    this.name = start.name;
    this.session = start.session;
    this.require = start.require;
    this.start = start;
    this.cols = start.cols;
    this.rows = start.rows;

    if (host.ready === undefined) {
      this.openCheckedConnection(start);
    } else {
      void this.startWhenReady(host.ready, start);
    }
  }

  readonly onData = (listener: (data: string) => void) => {
    this.dataListeners.add(listener);

    return {
      dispose: () => {
        this.dataListeners.delete(listener);
      },
    };
  };

  readonly onExit = (listener: (exit: HarnessExit) => void) => {
    this.exitListeners.add(listener);

    return {
      dispose: () => {
        this.exitListeners.delete(listener);
      },
    };
  };

  readonly onAttachment = (listener: (attachment: HarnessAttachment) => void) => {
    this.attachmentListeners.add(listener);

    return {
      dispose: () => {
        this.attachmentListeners.delete(listener);
      },
    };
  };

  readonly write = (data: string): void => {
    const bytes = new TextEncoder().encode(data);

    if (this.isStarted() && this.connection !== null) {
      this.connection.write(bytes);
    } else if (!this.isDone()) {
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
    if (this.isStarted() && this.connection !== null) {
      this.connection.sendSignal('SIGHUP');
    } else {
      this.state.send({ type: 'KILL_REQUESTED' });
    }
  };

  // Only an exit impd reports counts: a host that lost the process or went
  // to sleep with it inside confirms nothing.
  readonly waitForExit = (timeoutMs: number): Promise<boolean> => {
    const confirmed = this.getExitConfirmation();

    if (confirmed !== null) {
      return Promise.resolve(confirmed);
    }

    const waited = Promise.withResolvers<boolean>();

    const waiter = {
      waited,
      timer: setTimeout(() => {
        this.exitWaiters.delete(waiter);
        waited.resolve(false);
      }, timeoutMs),
    };

    this.exitWaiters.add(waiter);

    return waited.promise;
  };

  readonly waitForStart = (): Promise<HarnessStart> => {
    const outcome = this.getStartOutcome();

    if (outcome === 'started') {
      return Promise.resolve({ created: this.created ?? true });
    }

    if (outcome !== null) {
      return Promise.reject(outcome);
    }

    const waited = Promise.withResolvers<HarnessStart>();

    this.startWaiters.add(waited);

    return waited.promise;
  };

  readonly detach = (): void => {
    if (this.isDone()) {
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

  // oxlint-disable-next-line prefer-readonly-parameter-types -- a promise is a live handle
  private async startWhenReady(ready: Promise<void>, start: ImpSessionRequest): Promise<void> {
    try {
      await ready;
    } catch (error) {
      if (!this.isDone()) {
        this.emitExit({
          exitCode: 1,
          reason: 'ended',
          detail: `imp refused the report socket (${error instanceof Error ? error.message : String(error)})`,
        });
      }

      return;
    }

    // A resize while the host readied changed the size the start asks for.
    if (!this.isDone()) {
      this.openCheckedConnection({ ...start, cols: this.cols, rows: this.rows });
    }
  }

  // An impd from before exec requirements ignores them and runs the
  // command anyway, so a request that has any goes out only after impd
  // shows it honours them; otherwise the harness ends as impd's own
  // client refuses an outdated impd, and nothing runs.
  private openCheckedConnection(request: ImpSessionRequest): void {
    if (request.require === undefined || request.require.length === 0) {
      this.openConnection(request);

      return;
    }

    void this.openRequiredConnection(request);
  }

  private async openRequiredConnection(request: ImpSessionRequest): Promise<void> {
    let execRequire: boolean;

    try {
      const features = await this.port.readFeatures();

      execRequire = features.execRequire;
    } catch (error) {
      if (!this.isDone() && !this.host.isSuspending()) {
        const detail = error instanceof Error ? error.message : String(error);

        this.applyOutcome({ kind: 'unreachable', detail }, false);
      }

      return;
    }

    if (this.isDone() || this.host.isSuspending()) {
      return;
    }

    if (!execRequire) {
      this.applyOutcome(
        {
          kind: 'failed',
          code: 'PRECONDITION_FAILED',
          message: `impd for imp ${this.name} does not honour exec requirements`,
          data: { reason: 'impd_outdated' },
        },
        false,
      );

      return;
    }

    const admit = this.host.admit;

    if (admit === undefined) {
      this.openConnection(request);

      return;
    }

    try {
      await admit(request.kind, (ticket) => {
        if (this.isDone() || this.host.isSuspending()) {
          ticket.release();
        } else {
          this.openConnection(request, ticket);
        }
      });
    } catch (error) {
      if (!this.isDone()) {
        this.applyAdmissionRefusal(error);
      }
    }
  }

  // Whether an admitted request may still go out as its connection opens.
  // A refusal there, or a check that throws, closes the connection unsent
  // and ends the harness with it, once the port has returned to the
  // caller. Only a start that passes counts as sent.
  private checkTicket(ticket: LaunchTicket, kind: ImpSessionRequest['kind']): boolean {
    let refusal: DaemonError | null;

    try {
      refusal = ticket.check();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);

      refusal = new DaemonError(
        'internal',
        `imp ${this.name}'s harness could not check its admission: ${detail}`,
      );
    }

    if (refusal === null) {
      if (kind === 'start') {
        this.state.send({ type: 'START_SENT' });
      }

      return true;
    }

    queueMicrotask(() => {
      if (!this.isDone()) {
        this.connection = null;

        this.applyAdmissionRefusal(refusal);
      }
    });

    return false;
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

  // A request without a ticket counts as sent once the port has it; one
  // with a ticket only once its check passes, and the ticket goes back
  // whenever the connection ends or the harness lets go of it.
  private openConnection(request: ImpSessionRequest, ticket?: LaunchTicket): void {
    const gate = ticket === undefined ? undefined : () => this.checkTicket(ticket, request.kind);

    const handlers: ImpSessionHandlers = {
      onStarted: (started) => {
        if (this.connection === connection) {
          this.applyStarted(connection, started);
        }
      },
      onOutput: (data) => {
        if (this.connection === connection) {
          this.applyOutput(data);
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

    if (ticket === undefined && request.kind === 'start') {
      this.state.send({ type: 'START_SENT' });
    }

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

    if (offsets === null || offsets.resume === undefined) {
      if (this.needsFreshScreen()) {
        this.decoder = new TextDecoder();

        this.emitData(SCREEN_RESET);
      }

      this.highWater = offsets?.offset ?? 0;
    }

    this.cursor =
      offsets === null ? null : { bootId: offsets.bootId, generation: offsets.executionGeneration };

    this.nextOffset = offsets?.offset ?? 0;
    this.preludeLeft = offsets?.prelude ?? 0;
    this.failures = 0;

    // A start resumes the screen and takes the waiting kill with it.
    const hasKill = this.hasPendingKill();

    this.created ??= started.created;

    this.state.send({ type: 'CONNECTION_STARTED' });
    this.emitStartOutcome();
    this.emitAttachment('attached');

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

  // The mode bytes ahead of a fresh replay go to the screen uncounted; every
  // byte after them sits at an offset, and one below the high-water mark is
  // a repeat the daemon already has.
  // oxlint-disable-next-line prefer-readonly-parameter-types -- output bytes have no readonly form
  private applyOutput(data: Uint8Array): void {
    let bytes = data;

    if (this.preludeLeft > 0) {
      const prelude = bytes.subarray(0, this.preludeLeft);

      this.preludeLeft -= prelude.length;

      this.emitData(this.decoder.decode(prelude, { stream: true }));

      bytes = bytes.subarray(prelude.length);
    }

    if (this.cursor !== null) {
      const start = this.nextOffset;

      this.nextOffset += bytes.length;
      bytes = bytes.subarray(Math.max(0, this.highWater - start));
      this.highWater = Math.max(this.highWater, this.nextOffset);
    }

    if (bytes.length > 0) {
      this.emitData(this.decoder.decode(bytes, { stream: true }));
    }
  }

  private async waitForOutcome(
    connection: ImpSessionConnection,
    ticket: LaunchTicket | null,
  ): Promise<void> {
    const outcome = await connection.outcome;

    ticket?.release();

    if (this.connection !== connection || this.isDone() || this.host.isSuspending()) {
      return;
    }

    const wasStarted = this.isStarted();

    this.connection = null;

    this.state.send({ type: 'CONNECTION_ENDED' });
    this.applyOutcome(outcome, wasStarted);
  }

  // impd closes a connection whose send it dropped under backpressure with
  // 1011, and detaches a slow one: either resumes at once. A drop resumes at
  // once only on a connection that had started, so a connection impd drops
  // before it answers counts as a failed reconnect.
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

        this.cursor = null;

        this.scheduleReconnect(outcome, 0);
      })
      .with('NO_SESSION', () => {
        this.emitExit(buildLostExit(outcome.data, this.cursor));
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
    const data = parsePrecondition(outcome.data);

    match(data.reason)
      .with('impd_outdated', () => {
        this.startRefusal = new DaemonError(
          'auth_impd_too_old',
          `impd for imp ${this.name} does not honour exec requirements; upgrade it to 0.30.0 or later`,
          { imp: this.name, execRequire: false },
        );

        this.emitExit({
          exitCode: 1,
          reason: 'ended',
          detail: 'impd too old to require the broker',
        });
      })
      .with('broker_not_ready', () => {
        const detail = data.detail ?? 'no detail';

        this.startRefusal = new DaemonError(
          'broker_not_ready',
          `imp ${this.name} refused to start the harness: its credential broker is not ready (${detail})`,
          { imp: this.name, detail },
        );

        this.emitExit({ exitCode: 1, reason: 'ended', detail: `imp broker not ready (${detail})` });
      })
      .otherwise(() => {
        this.emitExit({ exitCode: 1, reason: 'ended', detail: formatOutcome(outcome) });
      });
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

    this.emitAttachment('reattaching');

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;

      if (!this.isDone()) {
        const next = this.hasSentStart()
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
    const cursor = this.needsFreshScreen() ? null : this.cursor;

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
      ...(this.require === undefined ? {} : { require: this.require }),
      ...(cursor === null
        ? {}
        : { resumeFrom: { executionGeneration: cursor.generation, offset: this.highWater } }),
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
      previous !== undefined && previous.executionGeneration === this.cursor?.generation
        ? { exitCode: previous.exitCode ?? 1, reason: 'exited' }
        : { exitCode: 1, reason: 'ended', detail: 'imp replaced the process' };

    this.connection = null;

    connection.close();
    this.emitExit(exit);
  }

  private emitData(text: string): void {
    for (const listener of this.dataListeners) {
      listener(text);
    }
  }

  private emitAttachment(attachment: HarnessAttachment): void {
    for (const listener of this.attachmentListeners) {
      listener(attachment);
    }
  }

  private emitExit(exit: HarnessExit): void {
    const listeners = [...this.exitListeners];

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

    const exited = this.getExitConfirmation() ?? false;

    for (const waiter of this.exitWaiters) {
      clearTimeout(waiter.timer);

      waiter.waited.resolve(exited);
    }

    this.exitWaiters.clear();
    this.dataListeners.clear();
    this.exitListeners.clear();
    this.attachmentListeners.clear();
  }

  // Each wait on the start settles once the start has settled.
  private emitStartOutcome(): void {
    const outcome = this.getStartOutcome();

    if (outcome === null) {
      return;
    }

    for (const waited of this.startWaiters) {
      if (outcome === 'started') {
        waited.resolve({ created: this.created ?? true });
      } else {
        waited.reject(outcome);
      }
    }

    this.startWaiters.clear();
  }

  private isStarted(): boolean {
    return this.state.getSnapshot().matches({ run: { following: { connection: 'live' } } });
  }

  private isDone(): boolean {
    return this.state.getSnapshot().matches({ run: 'ended' });
  }

  private hasSentStart(): boolean {
    return this.state.getSnapshot().matches({ run: { following: { process: 'sent' } } });
  }

  // Whether the next connection replaces the screen rather than resuming.
  private needsFreshScreen(): boolean {
    return this.state.getSnapshot().matches({ run: { following: { screen: 'fresh' } } });
  }

  private hasPendingKill(): boolean {
    return this.state.getSnapshot().matches({ run: { following: { kill: 'pending' } } });
  }

  // Whether the process exited, once the harness stops being followed;
  // null until then.
  private getExitConfirmation(): boolean | null {
    const snapshot = this.state.getSnapshot();

    if (snapshot.matches({ run: { ended: 'exited' } })) {
      return true;
    }

    return snapshot.matches({ run: 'ended' }) ? false : null;
  }

  // How the harness's start settled, or null while it has not.
  private getStartOutcome(): 'started' | Readonly<DaemonError> | null {
    const snapshot = this.state.getSnapshot();

    if (snapshot.matches({ start: 'started' })) {
      return 'started';
    }

    return snapshot.matches({ start: 'refused' }) ? snapshot.context.refusal : null;
  }
}

// What ended a process impd no longer holds: the kept previous generation
// of the same boot, and impd's cold boots, newest first. Each part is read
// on its own, and one that does not read is no evidence.
const LOST_BOOT_SCHEMA = z.object({ bootId: z.string() });
const LOST_PREVIOUS_SCHEMA = z.object({ previous: z.unknown() });
const LOST_COLD_BOOTS_SCHEMA = z.object({ coldBoots: z.array(z.unknown()) });
const GENERATION_SCHEMA = z.object({ executionGeneration: z.string() });
const EXIT_CODE_SCHEMA = z.object({ exitCode: z.number() });

// A boot whose id is not text still holds its place in the order.
const COLD_BOOT_SCHEMA = z.object({ bootId: z.unknown().optional() });
const CAUSE_SCHEMA = z.object({ cause: z.string() });

// What ended a process impd no longer holds. In the same boot, the kept
// previous generation gives its exit. Across a cold boot, the first boot
// after the daemon's own gives the cause; without the daemon's boot among
// impd's last cold boots, the cause is unknown.
function buildLostExit(
  data: unknown,
  cursor: Readonly<{ bootId: string; generation: string }> | null,
): HarnessExit {
  const bootID = LOST_BOOT_SCHEMA.safeParse(data).data?.bootId;
  const previous = LOST_PREVIOUS_SCHEMA.safeParse(data).data?.previous;

  if (cursor !== null && bootID === cursor.bootId) {
    const generation = GENERATION_SCHEMA.safeParse(previous);
    const exitCode = EXIT_CODE_SCHEMA.safeParse(previous);
    const isOwn = generation.data?.executionGeneration === cursor.generation;

    return isOwn
      ? { exitCode: exitCode.data?.exitCode ?? 1, reason: 'exited' }
      : { exitCode: 1, reason: 'ended', detail: 'ended, cause unknown' };
  }

  const boots = collectColdBoots(LOST_COLD_BOOTS_SCHEMA.safeParse(data).data?.coldBoots ?? []);
  const own = cursor === null ? -1 : boots.findIndex((boot) => boot.bootId === cursor.bootId);
  const next = own > 0 ? boots[own - 1] : undefined;

  return next === undefined
    ? { exitCode: 1, reason: 'ended', detail: 'ended, cause unknown' }
    : { exitCode: 1, reason: 'ended', detail: `imp rebooted (${next.cause})` };
}

// impd's cold boots, newest first, as far as each one reads.
function collectColdBoots(
  entries: readonly unknown[],
): { readonly bootId: unknown; readonly cause: string }[] {
  return entries.flatMap((entry) => {
    const boot = COLD_BOOT_SCHEMA.safeParse(entry);
    const cause = CAUSE_SCHEMA.safeParse(entry);

    return boot.success
      ? [{ bootId: boot.data.bootId, cause: cause.data?.cause ?? 'unknown' }]
      : [];
  });
}

// The state impd gives for an imp that cannot run the session.
const IMP_STATE_SCHEMA = z.object({ state: z.string() });

// A sleeping imp suspends the session; any other state ends it.
function buildStateExit(data: unknown): HarnessExit {
  const parsed = IMP_STATE_SCHEMA.safeParse(data);
  const state = parsed.success ? parsed.data.state : 'not running';

  return state === 'sleeping'
    ? { exitCode: 0, reason: 'suspended' }
    : { exitCode: 1, reason: 'ended', detail: `imp is ${state}` };
}

// impd's reason for a refused precondition, and its detail, each read on its
// own so a detail that is not text leaves the reason.
const PRECONDITION_REASON_SCHEMA = z.object({ reason: z.string() });
const PRECONDITION_DETAIL_SCHEMA = z.object({ detail: z.string() });

function parsePrecondition(data: unknown): { reason?: string; detail?: string } {
  const reason = PRECONDITION_REASON_SCHEMA.safeParse(data);
  const detail = PRECONDITION_DETAIL_SCHEMA.safeParse(data);

  return {
    ...(reason.success && { reason: reason.data.reason }),
    ...(detail.success && { detail: detail.data.detail }),
  };
}

// A refusal's message as detail a session list row can hold: credentials
// redacted while line breaks still bound a header's value, then control
// characters taken out so the text cannot redraw the row, and whitespace
// flattened to one line.
function buildSafeDetail(message: string): string {
  return sanitizeDetail(message)
    .replaceAll(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replaceAll(/\s+/gu, ' ')
    .trim();
}

// An end other than an exit, as a session's last message.
function formatOutcome(outcome: Exclude<ImpSessionOutcome, { kind: 'exit' }>): string {
  return match(outcome)
    .with({ kind: 'failed' }, (ended) => {
      const code = ended.code ?? 'error';
      const detail = buildSafeDetail(ended.message);

      const line =
        detail === ''
          ? `imp refused the session (${code})`
          : `imp refused the session (${code}): ${detail}`;

      return truncateSummary(line);
    })
    .with({ kind: 'detached' }, (ended) => `imp detached the session (${ended.reason})`)
    .with({ kind: 'closed' }, (ended) => `imp connection closed (${ended.reason})`)
    .with({ kind: 'unreachable' }, () => 'imp unreachable')
    .with({ kind: 'unauthorized' }, () => 'imp refused the token')
    .with(
      { kind: 'local_error' },
      (ended) => `imp connection failed in the daemon (${ended.detail})`,
    )
    .with({ kind: 'bad_message' }, () => 'imp sent a bad message')
    .exhaustive();
}
