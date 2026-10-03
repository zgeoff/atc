import { randomBytes, randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { spawn } from 'bun-pty';
import type { IPty } from 'bun-pty';
import type {
  ColdBoot,
  ColdBootCause,
  ImpCommand,
  ImpCommandResult,
  ImpCreateSpec,
  ImpFeatures,
  ImpLease,
  ImpPort,
  ImpRelayConnection,
  ImpReverseForward,
  ImpSessionConnection,
  ImpSessionHandlers,
  ImpSessionOutcome,
  ImpSessionRequest,
  ImpState,
  ImpView,
  PreviousGeneration,
  ResumeResult,
} from '../src/daemon/imp-port';
import { ImpPortError } from '../src/daemon/imp-port-error';

// impd keeps exactly this many bytes of each generation's output.
const RING_BYTES = 262_144;

// The mode bytes a fresh attach sends ahead of a ring that has wrapped.
const PRELUDE = '\u001B[0m';

// The PATH every fixture process runs with: a guest's own, never the
// daemon's.
const GUEST_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

/**
 * An in-process stand-in for impd behind the imp port. Each imp is a set of
 * real `bun-pty` processes on this machine; a sleeping imp stops them with
 * SIGSTOP and a wake continues them, so a memory wake keeps each process
 * and its generation. Every session keeps an exact 262144-byte ring with
 * offsets, a fresh attach skips to the next line and sends a mode prelude,
 * and impd's refusals carry its codes and data: `LEASED`, `LEASE_NOT_HELD`,
 * `NO_SESSION`, `INVALID_STATE`, `INVALID_RESUME`, and `NOT_FOUND`. Leases
 * belong to principals; the port acts as `principal`, and a test adds other
 * owners' leases, cold boots, and dropped sockets through the controls.
 */
export class FixtureImpPort implements ImpPort {
  // Every port call, in order, as `<call> <imp> [<detail>]`.
  readonly calls: string[] = [];

  // Every session request the port received, in order.
  readonly sessionRequests: ImpSessionRequest[] = [];

  features: ImpFeatures = { sessionOffsets: true, leases: true };

  // What a session's agent carries: `none` replays on every connection and
  // ignores resumes.
  continuity: 'offsets' | 'none' = 'offsets';

  // How many bytes before the asked offset an exact resume starts, as
  // impd's at-least-once delivery allows.
  resumeOverlap = 0;

  // Session answers held back while a test lets output pile up, or null
  // when answers go out at once.
  private held: (() => void)[] | null = null;

  // How many of the next session requests impd drops before it answers,
  // and the close code it drops them with.
  private drops = { count: 0, closeCode: 1011 };

  // Lease acquisitions that go through before the next one fails, and
  // impd's code for that failure, or null for none.
  private acquireFailure: { skip: number; readonly code: string } | null = null;

  // A refusal the next session request gets instead of an answer.
  private nextFailure: { readonly code: string; readonly data: unknown } | null = null;

  private readonly principal: string;

  private readonly imps = new Map<string, FixtureImp>();

  private readonly forwards = new Set<{ stop: () => void }>();

  constructor(principal = 'token:atc') {
    this.principal = principal;
  }

  readFeatures(): Promise<ImpFeatures> {
    this.calls.push('system.info');

    return Promise.resolve(this.features);
  }

  readImp(name: string): Promise<ImpView | null> {
    this.calls.push(`imps.get ${name}`);

    const imp = this.imps.get(name);
    const view = imp === undefined ? null : this.buildView(imp);

    return Promise.resolve(view);
  }

  createImp(spec: ImpCreateSpec): Promise<ImpView> {
    this.calls.push(`imps.create ${spec.name}`);

    if (this.imps.has(spec.name)) {
      return Promise.reject(
        new ImpPortError('CONFLICT', `imp ${spec.name} exists`, { kind: 'imp', name: spec.name }),
      );
    }

    const imp: FixtureImp = {
      name: spec.name,
      state: 'stopped',
      bootId: '',
      coldBoots: [],
      leases: new Map(),
      sessions: new Map(),
      previous: new Map(),
    };

    this.imps.set(spec.name, imp);
    this.bootCold(imp, 'start');

    return Promise.resolve(this.buildView(imp));
  }

  acquireLease(name: string, label: string, ttlSeconds: number): Promise<ImpLease> {
    this.calls.push(`leases.acquire ${name} ${label}`);

    const failure = this.acquireFailure;

    if (failure !== null) {
      if (failure.skip === 0) {
        this.acquireFailure = null;

        return Promise.reject(
          new ImpPortError(failure.code, `impd refused the lease (${failure.code})`),
        );
      }

      failure.skip -= 1;
    }

    if (label === 'hold' || ttlSeconds < 10 || ttlSeconds > 3600) {
      return Promise.reject(new ImpPortError('BAD_REQUEST', 'the label or ttl is not allowed'));
    }

    const imp = this.imps.get(name);

    if (imp === undefined) {
      return Promise.reject(buildNotFound(name));
    }

    this.updateAwake(imp);

    const until = Date.now() + ttlSeconds * 1000;

    imp.leases.set(`${this.principal}\u0000${label}`, { principal: this.principal, label, until });

    return Promise.resolve(buildLease(name, this.principal, label, until));
  }

  renewLease(name: string, label: string, ttlSeconds: number): Promise<ImpLease> {
    this.calls.push(`leases.renew ${name} ${label}`);

    const imp = this.imps.get(name);
    const key = `${this.principal}\u0000${label}`;
    const lease = imp?.leases.get(key);

    if (imp === undefined || lease === undefined || lease.until <= Date.now()) {
      return Promise.reject(new ImpPortError('LEASE_NOT_HELD', 'the caller holds no such lease'));
    }

    const until = Date.now() + ttlSeconds * 1000;

    imp.leases.set(key, { ...lease, until });

    return Promise.resolve(buildLease(name, this.principal, label, until));
  }

  releaseLease(name: string, label: string): Promise<boolean> {
    this.calls.push(`leases.release ${name} ${label}`);

    const imp = this.imps.get(name);

    if (imp === undefined) {
      return Promise.reject(buildNotFound(name));
    }

    return Promise.resolve(imp.leases.delete(`${this.principal}\u0000${label}`));
  }

  suspendImp(name: string): Promise<void> {
    this.calls.push(`imps.sleep ${name}`);

    const imp = this.imps.get(name);

    if (imp === undefined) {
      return Promise.reject(buildNotFound(name));
    }

    const live = [...imp.leases.values()].filter((lease) => lease.until > Date.now());

    if (imp.state === 'running' && live.length > 0) {
      const own = live.filter((lease) => lease.principal === this.principal);
      const others = live.filter((lease) => lease.principal !== this.principal);

      const otherPrincipals = new Set(others.map((lease) => lease.principal));

      return Promise.reject(
        new ImpPortError('LEASED', 'the imp is leased', {
          leases: own.map((lease) => buildLease(name, lease.principal, lease.label, lease.until)),
          otherCount: otherPrincipals.size,
        }),
      );
    }

    this.updateAsleep(imp);

    return Promise.resolve();
  }

  destroyImp(name: string): Promise<void> {
    this.calls.push(`imps.destroy ${name}`);

    const imp = this.imps.get(name);

    if (imp === undefined) {
      return Promise.reject(buildNotFound(name));
    }

    for (const proc of imp.sessions.values()) {
      proc.connection?.finish({ kind: 'closed', reason: 'imp destroyed', closeCode: 1000 });
      proc.connection = null;
      proc.exited ??= { code: null };

      tryKill(proc.pty, 'SIGKILL');
    }

    this.imps.delete(name);

    return Promise.resolve();
  }

  openSession(request: ImpSessionRequest, handlers: ImpSessionHandlers): ImpSessionConnection {
    this.calls.push(`exec.${request.kind} ${request.name} ${request.session}`);
    this.sessionRequests.push(request);

    const outcome = Promise.withResolvers<ImpSessionOutcome>();

    const connection: FixtureConnection = {
      handlers,
      sent: 0,
      finished: false,
      process: null,
      finish: (result) => {
        if (connection.finished) {
          return;
        }

        connection.finished = true;

        if (connection.process?.connection === connection) {
          connection.process.connection = null;
        }

        outcome.resolve(result);
      },
    };

    // impd answers over the network: nothing reaches the caller before
    // openSession returns.
    setTimeout(() => {
      if (this.held === null) {
        this.answerSession(request, connection);
      } else {
        this.held.push(() => {
          this.answerSession(request, connection);
        });
      }
    }, 0);

    return {
      outcome: outcome.promise,
      write: (data) => {
        if (!connection.finished && connection.process !== null) {
          connection.process.pty.write(new TextDecoder().decode(data));
        }
      },
      resize: (cols, rows) => {
        if (!connection.finished && connection.process !== null) {
          connection.process.pty.resize(cols, rows);
        }
      },
      sendSignal: (signal) => {
        if (!connection.finished && connection.process !== null) {
          tryKill(connection.process.pty, 'SIGCONT');
          tryKill(connection.process.pty, toSignal(signal));
        }
      },
      close: () => {
        connection.finish({ kind: 'closed', reason: 'closed by the client', closeCode: 1000 });
      },
    };
  }

  // oxlint-disable-next-line prefer-readonly-parameter-types -- the command's input bytes have no readonly form
  async runCommand(name: string, command: ImpCommand): Promise<ImpCommandResult> {
    this.calls.push(`exec.run ${name} ${command.argv.join(' ')}`);

    const imp = this.imps.get(name);

    if (imp === undefined) {
      throw buildNotFound(name);
    }

    if (imp.state !== 'running') {
      throw new ImpPortError('INVALID_STATE', `imp ${name} is ${imp.state}`, {
        state: imp.state,
        allowed: ['running'],
      });
    }

    const proc = Bun.spawn([...command.argv], {
      ...(command.cwd === undefined ? {} : { cwd: command.cwd }),
      env: { PATH: GUEST_PATH },
      stdin: command.stdin ?? 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).bytes(),
      new Response(proc.stderr).bytes(),
      proc.exited,
    ]);

    return { code, stdout, stderr };
  }

  openReverseForward(
    name: string,
    guestPath: string,
    onConnection: (connection: ImpRelayConnection) => void,
  ): ImpReverseForward {
    this.calls.push(`reverse ${name} ${guestPath}`);

    const server = Bun.listen<FixtureRelay>({
      unix: guestPath,
      socket: {
        open(socket) {
          const relay: FixtureRelay = { dataListeners: [], closeListeners: [] };

          socket.data = relay;

          onConnection({
            onData: (listener) => {
              relay.dataListeners.push(listener);
            },
            onClose: (listener) => {
              relay.closeListeners.push(listener);
            },
            close: () => {
              socket.end();
            },
          });
        },
        data(socket, buf) {
          for (const listener of socket.data.dataListeners) {
            listener(new Uint8Array(buf));
          }
        },
        close(socket) {
          for (const listener of socket.data.closeListeners) {
            listener();
          }
        },
        error() {},
      },
    });

    const forward = {
      stop: () => {
        server.stop(true);

        rmSync(guestPath, { force: true });

        this.forwards.delete(forward);
      },
    };

    this.forwards.add(forward);

    return { listening: Promise.resolve(), stop: forward.stop };
  }

  /**
   * Adds a lease another principal holds on an imp, so it refuses to sleep.
   */
  acquireOtherLease(name: string, principal: string, label: string, ttlSeconds: number): void {
    const imp = this.getImp(name);

    imp.leases.set(`${principal}\u0000${label}`, {
      principal,
      label,
      until: Date.now() + ttlSeconds * 1000,
    });
  }

  /**
   * Puts an imp to sleep with force, as a person's `imp sleep` does: every
   * lease ends and every connection is detached as lost.
   */
  suspendWithForce(name: string): void {
    const imp = this.getImp(name);

    imp.leases.clear();
    this.updateAsleep(imp);
  }

  /**
   * Boots an imp cold for the given cause: every process ends without a
   * delivered exit, and every connection is detached as lost.
   */
  bootImpCold(name: string, cause: ColdBootCause): void {
    this.bootCold(this.getImp(name), cause);
  }

  /**
   * Closes the connection on a session with a WebSocket close code, as impd
   * does when it drops a send under backpressure (1011).
   */
  stopConnection(name: string, session: string, closeCode: number): void {
    const proc = this.getImp(name).sessions.get(session);

    proc?.connection?.finish({ kind: 'closed', reason: `code ${closeCode}`, closeCode });
  }

  /**
   * Holds every session answer back, as a slow network does, until the
   * hold stops.
   */
  startAnswerHold(): void {
    this.held ??= [];
  }

  /**
   * Sends every held answer, in order, and answers at once again.
   */
  stopAnswerHold(): void {
    const held = this.held ?? [];

    this.held = null;

    for (const answer of held) {
      answer();
    }
  }

  /**
   * Fails a lease acquisition with an impd code once `skip` more have gone
   * through.
   */
  setAcquireFailure(skip: number, code: string): void {
    this.acquireFailure = { skip, code };
  }

  /**
   * Drops the next session requests before impd answers them, closing
   * each with the close code.
   */
  setSessionDrops(count: number, closeCode: number): void {
    this.drops = { count, closeCode };
  }

  /**
   * Refuses the next session request with an impd code and its data.
   */
  setNextSessionFailure(code: string, data: unknown): void {
    this.nextFailure = { code, data };
  }

  // The state an imp is in, or null when it does not exist.
  findState(name: string): ImpState | null {
    return this.imps.get(name)?.state ?? null;
  }

  // The names of the imps the fixture holds.
  collectImpNames(): string[] {
    return [...this.imps.keys()];
  }

  // The boot an imp runs in.
  getBootID(name: string): string {
    return this.getImp(name).bootId;
  }

  // The generation running under a session name.
  getGeneration(name: string, session: string): string {
    const proc = this.getImp(name).sessions.get(session);

    if (proc === undefined) {
      throw new Error(`no session ${session} on imp ${name}`);
    }

    return proc.generation;
  }

  // The offset after the last byte a session's running generation wrote.
  getEnd(name: string, session: string): number {
    const proc = this.getImp(name).sessions.get(session);

    if (proc === undefined) {
      throw new Error(`no session ${session} on imp ${name}`);
    }

    return proc.end;
  }

  [Symbol.dispose](): void {
    for (const imp of this.imps.values()) {
      for (const proc of imp.sessions.values()) {
        tryKill(proc.pty, 'SIGCONT');
        tryKill(proc.pty, 'SIGKILL');
      }
    }

    for (const forward of this.forwards) {
      forward.stop();
    }

    this.imps.clear();
  }

  private getImp(name: string): FixtureImp {
    const imp = this.imps.get(name);

    if (imp === undefined) {
      throw new Error(`no imp ${name}`);
    }

    return imp;
  }

  private buildView(imp: FixtureImp): ImpView {
    const live = [...imp.leases.values()].filter((lease) => lease.until > Date.now());
    const own = live.filter((lease) => lease.principal === this.principal);
    const others = live.filter((lease) => lease.principal !== this.principal);

    return {
      name: imp.name,
      state: imp.state,
      leases: own.map((lease) => buildLease(imp.name, lease.principal, lease.label, lease.until)),
      otherLeaseCount: new Set(others.map((lease) => lease.principal)).size,
    };
  }

  // A sleeping imp wakes from memory with every process as it was; a
  // stopped one boots cold.
  private updateAwake(imp: FixtureImp): void {
    if (imp.state === 'sleeping') {
      imp.state = 'running';

      for (const proc of imp.sessions.values()) {
        tryKill(proc.pty, 'SIGCONT');
      }
    } else if (imp.state !== 'running') {
      this.bootCold(imp, 'start');
    }
  }

  private updateAsleep(imp: FixtureImp): void {
    if (imp.state !== 'running') {
      return;
    }

    imp.state = 'sleeping';

    for (const proc of imp.sessions.values()) {
      tryKill(proc.pty, 'SIGSTOP');
      proc.connection?.finish({ kind: 'detached', reason: 'lost', offset: proc.end });
    }
  }

  private bootCold(imp: FixtureImp, cause: ColdBootCause): void {
    for (const proc of imp.sessions.values()) {
      proc.connection?.finish({ kind: 'detached', reason: 'lost', offset: proc.end });
      proc.ended = true;

      tryKill(proc.pty, 'SIGCONT');
      tryKill(proc.pty, 'SIGKILL');
    }

    imp.sessions.clear();
    imp.previous.clear();

    imp.state = 'running';
    imp.bootId = randomUUID();

    imp.coldBoots = [
      { bootId: imp.bootId, cause, at: new Date().toISOString() },
      ...imp.coldBoots,
    ].slice(0, 4);
  }

  private answerSession(request: ImpSessionRequest, connection: FixtureConnection): void {
    if (connection.finished) {
      return;
    }

    if (this.drops.count > 0) {
      this.drops.count -= 1;

      connection.finish({
        kind: 'closed',
        reason: `code ${this.drops.closeCode}`,
        closeCode: this.drops.closeCode,
      });

      return;
    }

    const failure = this.nextFailure;

    if (failure !== null) {
      this.nextFailure = null;

      connection.finish({
        kind: 'failed',
        code: failure.code,
        message: `impd refused the session (${failure.code})`,
        data: failure.data,
      });

      return;
    }

    const imp = this.imps.get(request.name);

    if (imp === undefined) {
      connection.finish({
        kind: 'failed',
        code: 'NOT_FOUND',
        message: `no imp ${request.name}`,
        data: { kind: 'imp', name: request.name },
      });

      return;
    }

    if (imp.state !== 'running' && request.kind === 'attach' && !request.wake) {
      connection.finish({
        kind: 'failed',
        code: 'INVALID_STATE',
        message: `imp ${imp.name} is ${imp.state}`,
        data: {
          state: imp.state,
          allowed: ['running'],
          ...(imp.state === 'creating' ? {} : { coldBoots: imp.coldBoots }),
        },
      });

      return;
    }

    this.updateAwake(imp);

    const running = imp.sessions.get(request.session);

    if (running === undefined && request.kind === 'attach') {
      const previous = imp.previous.get(request.session);

      connection.finish({
        kind: 'failed',
        code: 'NO_SESSION',
        message: `no session ${request.session}`,
        data: {
          bootId: imp.bootId,
          coldBoots: imp.coldBoots,
          ...(previous === undefined ? {} : { previous }),
        },
      });

      return;
    }

    const proc = running ?? this.startProcess(imp, request);

    if (proc === null) {
      return;
    }

    this.attachProcess(imp, proc, request, connection, running === undefined);
  }

  private startProcess(imp: FixtureImp, request: ImpSessionRequest): FixtureProcess | null {
    if (request.kind !== 'start') {
      return null;
    }

    const pty = spawn(request.argv[0] ?? 'false', request.argv.slice(1), {
      name: 'xterm-256color',
      cols: request.cols,
      rows: request.rows,
      cwd: request.cwd,
      env: { ...request.env },
    });

    const proc: FixtureProcess = {
      pty,
      generation: randomBytes(16).toString('hex'),
      ring: new Uint8Array(0),
      end: 0,
      exited: null,
      ended: false,
      connection: null,
    };

    imp.sessions.set(request.session, proc);

    pty.onData((text) => {
      const data = new TextEncoder().encode(text);

      proc.ring = mergeTail(proc.ring, data, RING_BYTES);
      proc.end += data.length;

      const connection = proc.connection;

      if (connection !== null) {
        connection.sent = proc.end;

        tryEmit(connection, () => {
          connection.handlers.onOutput(data);
        });
      }
    });

    pty.onExit((exit) => {
      if (proc.ended) {
        return;
      }

      const exitCode = exit.exitCode;

      proc.exited = { code: exitCode };

      imp.previous.set(request.session, {
        executionGeneration: proc.generation,
        end: proc.end,
        exitCode,
      });

      const connection = proc.connection;

      // An exit nobody received stays attachable until a connection
      // delivers it.
      if (connection !== null) {
        imp.sessions.delete(request.session);
        connection.finish({ kind: 'exit', code: exitCode, signal: null, offset: proc.end });
      }
    });

    return proc;
  }

  private attachProcess(
    imp: FixtureImp,
    proc: FixtureProcess,
    request: ImpSessionRequest,
    connection: FixtureConnection,
    created: boolean,
  ): void {
    const bufferStart = proc.end - proc.ring.length;
    let from = bufferStart;
    let prelude = '';
    let resume: ResumeResult | undefined;

    if (request.resumeFrom !== undefined && this.continuity === 'offsets') {
      const resumeFrom = request.resumeFrom;

      if (resumeFrom.executionGeneration !== proc.generation) {
        resume = {
          kind: 'generation_changed',
          executionGeneration: proc.generation,
          firstOffset: bufferStart,
        };
      } else if (resumeFrom.offset > proc.end) {
        connection.finish({
          kind: 'failed',
          code: 'INVALID_RESUME',
          message: 'the resume offset is past the end',
          data: { end: proc.end, bufferStart },
        });

        return;
      } else if (resumeFrom.offset < bufferStart) {
        resume = { kind: 'gap', from: resumeFrom.offset, to: bufferStart };
      } else {
        resume = { kind: 'exact' };
        from = Math.max(bufferStart, resumeFrom.offset - this.resumeOverlap);
      }
    } else if (bufferStart > 0) {
      // A ring that has wrapped can start inside an escape sequence, so a
      // fresh attach skips to the next line and resets the modes first.
      const newline = proc.ring.indexOf(0x0a);

      from = bufferStart + (newline === -1 ? 0 : newline + 1);
      prelude = PRELUDE;
    }

    proc.connection?.finish({
      kind: 'detached',
      reason: 'taken_over',
      offset: proc.connection.sent,
    });

    connection.process = proc;
    connection.sent = proc.end;

    const preludeBytes = new TextEncoder().encode(prelude);

    const previous = imp.previous.get(request.session);

    const started = tryEmit(connection, () => {
      connection.handlers.onStarted({
        created,
        output:
          this.continuity === 'none'
            ? { continuity: 'none' }
            : {
                continuity: 'offsets',
                bootId: imp.bootId,
                executionGeneration: proc.generation,
                bufferStart,
                end: proc.end,
                offset: from,
                prelude: preludeBytes.length,
                coldBoots: imp.coldBoots,
                ...(previous === undefined ? {} : { previous }),
                ...(resume === undefined ? {} : { resume }),
              },
      });
    });

    if (!started) {
      return;
    }

    const backlog = proc.ring.subarray(from - bufferStart);

    for (const bytes of [preludeBytes, backlog]) {
      const sent =
        bytes.length === 0 ||
        tryEmit(connection, () => {
          connection.handlers.onOutput(bytes);
        });

      if (!sent) {
        return;
      }
    }

    if (proc.exited !== null) {
      imp.sessions.delete(findSessionName(imp, proc));
      connection.finish({ kind: 'exit', code: proc.exited.code, signal: null, offset: proc.end });

      return;
    }

    proc.connection = connection;
  }
}

interface FixtureLease {
  readonly principal: string;
  readonly label: string;
  readonly until: number;
}

interface FixtureImp {
  readonly name: string;
  state: ImpState;
  bootId: string;
  coldBoots: ColdBoot[];
  readonly leases: Map<string, FixtureLease>;
  readonly sessions: Map<string, FixtureProcess>;
  readonly previous: Map<string, PreviousGeneration>;
}

interface FixtureProcess {
  readonly pty: IPty;
  readonly generation: string;
  ring: Uint8Array;
  end: number;
  exited: { readonly code: number | null } | null;

  // Ended by a cold boot: its exit is never delivered.
  ended: boolean;
  connection: FixtureConnection | null;
}

interface FixtureConnection {
  readonly handlers: ImpSessionHandlers;
  sent: number;
  finished: boolean;
  process: FixtureProcess | null;
  readonly finish: (outcome: ImpSessionOutcome) => void;
}

interface FixtureRelay {
  // oxlint-disable-next-line prefer-readonly-parameter-types -- relayed bytes have no readonly form
  readonly dataListeners: ((data: Uint8Array) => void)[];
  readonly closeListeners: (() => void)[];
}

function buildNotFound(name: string): ImpPortError {
  return new ImpPortError('NOT_FOUND', `no imp ${name}`, { kind: 'imp', name });
}

function buildLease(name: string, principal: string, label: string, until: number): ImpLease {
  return { name, owner: { principal, display: principal, label }, until };
}

// oxlint-disable-next-line prefer-readonly-parameter-types -- byte arrays have no readonly form
function mergeTail(ring: Uint8Array, data: Uint8Array, limit: number): Uint8Array {
  const joined = new Uint8Array(ring.length + data.length);

  joined.set(ring, 0);
  joined.set(data, ring.length);

  return joined.length > limit ? joined.slice(joined.length - limit) : joined;
}

// Calls a connection's handler as the imp client does: a handler that
// throws ends the connection with a local error and closes it.
function tryEmit(connection: FixtureConnection, emit: () => void): boolean {
  try {
    emit();

    return true;
  } catch (error) {
    connection.finish({
      kind: 'local_error',
      detail: error instanceof Error ? error.message : String(error),
    });

    return false;
  }
}

function findSessionName(imp: FixtureImp, proc: FixtureProcess): string {
  for (const [name, held] of imp.sessions) {
    if (held === proc) {
      return name;
    }
  }

  return '';
}

function toSignal(name: string): NodeJS.Signals {
  return name === 'SIGKILL' || name === 'SIGTERM' || name === 'SIGINT' ? name : 'SIGHUP';
}

function tryKill(pty: IPty, signal: NodeJS.Signals): void {
  try {
    process.kill(pty.pid, signal);
  } catch {}
}
