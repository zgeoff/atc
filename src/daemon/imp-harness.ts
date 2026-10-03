import { DaemonError } from '../protocol/daemon-error';
import { isRecord } from '../shared/report';
import type { HarnessAttachment, HarnessExit, HarnessHandle } from './execution-provider';
import type {
  ImpExecRequirement,
  ImpPort,
  ImpSessionConnection,
  ImpSessionOutcome,
  ImpSessionRequest,
  ImpSessionStarted,
  PreviousGeneration,
} from './imp-port';

// What the harness asks of the provider that started it.
interface ImpHarnessHost {
  // Whether the provider is putting the harness's host to sleep, so a
  // connection the sleep ends is the sleep's and not the harness's end.
  readonly isSuspending: () => boolean;

  // Called once, when the harness ends or the daemon lets go of it.
  readonly onDone: () => void;

  // Whether impd carries output offsets, so a reconnect can resume.
  readonly offsets: boolean;

  // The wait before each reconnect after a connection ends without an
  // exit; the harness ends once they run out.
  readonly reconnectDelaysMs: readonly number[];

  // Settles once the harness may start, such as when its report socket
  // listens; a rejection ends the harness before it starts.
  readonly ready?: Promise<void>;
}

// The bytes a fresh attach sends listeners ahead of its replay: reset the
// attributes, home the cursor, and clear the screen. A full terminal reset
// would also undo the modes of every attached client's own terminal.
const SCREEN_RESET = '\u001B[0m\u001B[H\u001B[2J';

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

  // The request that starts the process, and whether it went out to impd.
  // Until it has, a retry sends it again, since there is no process to
  // attach to.
  private readonly start: ImpSessionRequest;

  private startSent = false;

  private readonly dataListeners = new Set<(data: string) => void>();

  private readonly exitListeners = new Set<(exit: HarnessExit) => void>();

  private readonly attachmentListeners = new Set<(attachment: HarnessAttachment) => void>();

  private decoder = new TextDecoder();

  private connection: ImpSessionConnection | null = null;

  private started = false;

  private done = false;

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

  // Whether the next connection replaces the screen rather than resuming.
  private fresh = false;

  private failures = 0;

  // Connections in a row that a handler of ours ended. A start never clears
  // it, since the next start can fail the same way.
  private localErrors = 0;

  private killPending = false;

  // Whether the process exited, once the harness stops being followed, and
  // the waits on that answer until then.
  private exitConfirmed: boolean | null = null;

  private readonly exitWaiters = new Set<{
    readonly waited: PromiseWithResolvers<boolean>;
    readonly timer: ReturnType<typeof setTimeout>;
  }>();

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // How the harness's start settled: started once a connection first
  // starts the process or attaches to it, or the refusal it ended with
  // before that; null until then. The waits on that answer meanwhile.
  private startOutcome: 'started' | Readonly<DaemonError> | null = null;

  private readonly startWaiters = new Set<PromiseWithResolvers<void>>();

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

    if (this.started && this.connection !== null) {
      this.connection.write(bytes);
    } else if (!this.done) {
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
    if (this.started && this.connection !== null) {
      this.connection.sendSignal('SIGHUP');
    } else if (!this.done) {
      this.killPending = true;
    }
  };

  // Only an exit impd reports counts: a host that lost the process or went
  // to sleep with it inside confirms nothing.
  readonly waitForExit = (timeoutMs: number): Promise<boolean> => {
    if (this.exitConfirmed !== null) {
      return Promise.resolve(this.exitConfirmed);
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

  readonly waitForStart = (): Promise<void> => {
    if (this.startOutcome === 'started') {
      return Promise.resolve();
    }

    if (this.startOutcome !== null) {
      return Promise.reject(this.startOutcome);
    }

    const waited = Promise.withResolvers<void>();

    this.startWaiters.add(waited);

    return waited.promise;
  };

  readonly detach = (): void => {
    if (this.done) {
      return;
    }

    const connection = this.connection;

    this.stopFollowing();
    connection?.close();
  };

  // oxlint-disable-next-line prefer-readonly-parameter-types -- a promise is a live handle
  private async startWhenReady(ready: Promise<void>, start: ImpSessionRequest): Promise<void> {
    try {
      await ready;
    } catch (error) {
      if (!this.done) {
        this.emitExit({
          exitCode: 1,
          reason: 'ended',
          detail: `imp refused the report socket (${error instanceof Error ? error.message : String(error)})`,
        });
      }

      return;
    }

    // A resize while the host readied changed the size the start asks for.
    if (!this.done) {
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
      if (!this.done && !this.host.isSuspending()) {
        const detail = error instanceof Error ? error.message : String(error);

        this.applyOutcome({ kind: 'unreachable', detail }, false);
      }

      return;
    }

    if (this.done || this.host.isSuspending()) {
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

    this.openConnection(request);
  }

  private openConnection(request: ImpSessionRequest): void {
    const connection = this.port.openSession(request, {
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
    });

    this.connection = connection;
    this.started = false;
    this.startSent ||= request.kind === 'start';
    this.requestedSize = { cols: request.cols, rows: request.rows };
    void this.waitForOutcome(connection);
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
      if (this.fresh) {
        this.decoder = new TextDecoder();

        this.emitData(SCREEN_RESET);
      }

      this.highWater = offsets?.offset ?? 0;
    }

    this.cursor =
      offsets === null ? null : { bootId: offsets.bootId, generation: offsets.executionGeneration };

    this.nextOffset = offsets?.offset ?? 0;
    this.preludeLeft = offsets?.prelude ?? 0;
    this.fresh = false;
    this.failures = 0;
    this.started = true;

    this.updateStartOutcome('started');
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

    if (this.killPending) {
      this.killPending = false;

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

  private async waitForOutcome(connection: ImpSessionConnection): Promise<void> {
    const outcome = await connection.outcome;

    if (this.connection !== connection || this.done || this.host.isSuspending()) {
      return;
    }

    const wasStarted = this.started;

    this.connection = null;
    this.started = false;

    this.applyOutcome(outcome, wasStarted);
  }

  // A drop resumes at once only on a connection that had started, so a
  // connection impd drops before it answers counts as a failed reconnect.
  private applyOutcome(outcome: ImpSessionOutcome, wasStarted: boolean): void {
    if (outcome.kind === 'local_error') {
      this.applyLocalError(outcome);

      return;
    }

    this.localErrors = 0;

    if (outcome.kind === 'exit') {
      this.emitExit({ exitCode: outcome.code ?? 1, reason: 'exited' });

      return;
    }

    if (outcome.kind === 'failed') {
      this.applyRefusal(outcome);

      return;
    }

    if (outcome.kind === 'unauthorized' || outcome.kind === 'bad_message') {
      this.emitExit({ exitCode: 1, reason: 'ended', detail: formatOutcome(outcome) });

      return;
    }

    // impd closes a connection whose send it dropped under backpressure
    // with 1011, and detaches a slow one: either resumes at once.
    const isDropped =
      (outcome.kind === 'closed' && outcome.closeCode === 1011) ||
      (outcome.kind === 'detached' && outcome.reason === 'slow');

    const delay = isDropped && wasStarted ? 0 : null;

    this.scheduleReconnect(outcome, delay);
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
    if (outcome.code === 'INVALID_RESUME') {
      this.fresh = true;
      this.cursor = null;

      this.scheduleReconnect(outcome, 0);

      return;
    }

    if (outcome.code === 'NO_SESSION') {
      this.emitExit(buildLostExit(outcome.data, this.cursor));

      return;
    }

    if (outcome.code === 'INVALID_STATE') {
      const state = isRecord(outcome.data) ? outcome.data['state'] : undefined;

      const exit: HarnessExit =
        state === 'sleeping'
          ? { exitCode: 0, reason: 'suspended' }
          : {
              exitCode: 1,
              reason: 'ended',
              detail: `imp is ${typeof state === 'string' ? state : 'not running'}`,
            };

      this.emitExit(exit);

      return;
    }

    if (outcome.code === 'PRECONDITION_FAILED' && isImpdOutdated(outcome.data)) {
      this.startRefusal = new DaemonError(
        'auth_impd_too_old',
        `impd for imp ${this.name} does not honour exec requirements; upgrade it to 0.30.0 or later`,
        { imp: this.name, execRequire: false },
      );

      this.emitExit({ exitCode: 1, reason: 'ended', detail: 'impd too old to require the broker' });

      return;
    }

    if (outcome.code === 'PRECONDITION_FAILED' && isBrokerNotReady(outcome.data)) {
      const detail =
        isRecord(outcome.data) && typeof outcome.data['detail'] === 'string'
          ? outcome.data['detail']
          : 'no detail';

      this.startRefusal = new DaemonError(
        'broker_not_ready',
        `imp ${this.name} refused to start the harness: its credential broker is not ready (${detail})`,
        { imp: this.name, detail },
      );

      this.emitExit({ exitCode: 1, reason: 'ended', detail: `imp broker not ready (${detail})` });

      return;
    }

    this.emitExit({ exitCode: 1, reason: 'ended', detail: formatOutcome(outcome) });
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

      if (!this.done) {
        const next = this.startSent
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
    const cursor = this.fresh ? null : this.cursor;

    if (cursor === null) {
      this.fresh = true;
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

    this.fresh = true;

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

    this.updateStartOutcome(
      this.startRefusal ??
        new DaemonError(
          'host_unavailable',
          `imp ${this.name} ended the harness before it started (${exit.detail ?? 'process exited'})`,
          { provider: 'imp', problem: 'not_started' },
        ),
    );

    this.exitConfirmed = exit.reason === undefined || exit.reason === 'exited';

    this.stopFollowing();

    for (const listener of listeners) {
      listener(exit);
    }
  }

  // The first outcome counts; each wait settles with it.
  private updateStartOutcome(outcome: 'started' | Readonly<DaemonError>): void {
    if (this.startOutcome !== null) {
      return;
    }

    this.startOutcome = outcome;

    for (const waited of this.startWaiters) {
      if (outcome === 'started') {
        waited.resolve();
      } else {
        waited.reject(outcome);
      }
    }

    this.startWaiters.clear();
  }

  private stopFollowing(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);

      this.reconnectTimer = null;
    }

    this.done = true;
    this.connection = null;
    this.exitConfirmed ??= false;

    this.updateStartOutcome(
      new DaemonError(
        'host_unavailable',
        `the daemon let go of imp ${this.name}'s harness before it started`,
        {
          provider: 'imp',
          problem: 'not_started',
        },
      ),
    );

    for (const waiter of this.exitWaiters) {
      clearTimeout(waiter.timer);

      waiter.waited.resolve(this.exitConfirmed);
    }

    this.exitWaiters.clear();
    this.dataListeners.clear();
    this.exitListeners.clear();
    this.attachmentListeners.clear();
    this.host.onDone();
  }
}

// impd's refusal of a start whose broker is not ready.
function isBrokerNotReady(data: unknown): boolean {
  return isRecord(data) && data['reason'] === 'broker_not_ready';
}

// The refusal of an exec with requirements against an impd that would
// ignore them, which impd's client and the harness both give.
function isImpdOutdated(data: unknown): boolean {
  return isRecord(data) && data['reason'] === 'impd_outdated';
}

// What ended a process impd no longer holds. In the same boot, the kept
// previous generation gives its exit. Across a cold boot, the first boot
// after the daemon's own gives the cause; without the daemon's boot among
// impd's last cold boots, the cause is unknown.
function buildLostExit(
  data: unknown,
  cursor: Readonly<{ bootId: string; generation: string }> | null,
): HarnessExit {
  const record = isRecord(data) ? data : {};

  if (cursor !== null && record['bootId'] === cursor.bootId) {
    const previous = record['previous'];
    const isOwn = isRecord(previous) && previous['executionGeneration'] === cursor.generation;
    const exitCode = isOwn && typeof previous['exitCode'] === 'number' ? previous['exitCode'] : 1;

    return isOwn
      ? { exitCode, reason: 'exited' }
      : { exitCode: 1, reason: 'ended', detail: 'ended, cause unknown' };
  }

  const boots = collectColdBoots(record['coldBoots']);
  const own = cursor === null ? -1 : boots.findIndex((boot) => boot.bootId === cursor.bootId);
  const next = own > 0 ? boots[own - 1] : undefined;

  return next === undefined
    ? { exitCode: 1, reason: 'ended', detail: 'ended, cause unknown' }
    : { exitCode: 1, reason: 'ended', detail: `imp rebooted (${next.cause})` };
}

// impd's cold boots, newest first, as far as each one reads.
function collectColdBoots(value: unknown): { readonly bootId: unknown; readonly cause: string }[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((boot) => isRecord(boot))
    .map((boot) => ({
      bootId: boot['bootId'],
      cause: typeof boot['cause'] === 'string' ? boot['cause'] : 'unknown',
    }));
}

// An end other than an exit, as a session's last message.
function formatOutcome(outcome: Exclude<ImpSessionOutcome, { kind: 'exit' }>): string {
  if (outcome.kind === 'failed') {
    return `imp refused the session (${outcome.code ?? 'error'})`;
  }

  if (outcome.kind === 'detached') {
    return `imp detached the session (${outcome.reason})`;
  }

  if (outcome.kind === 'closed') {
    return `imp connection closed (${outcome.reason})`;
  }

  if (outcome.kind === 'unreachable') {
    return 'imp unreachable';
  }

  if (outcome.kind === 'unauthorized') {
    return 'imp refused the token';
  }

  if (outcome.kind === 'local_error') {
    return `imp connection failed in the daemon (${outcome.detail})`;
  }

  return 'imp sent a bad message';
}
