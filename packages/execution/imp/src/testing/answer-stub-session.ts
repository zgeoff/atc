import { randomBytes } from 'node:crypto';
import { isBrokerVariable } from '@atc/core';
import { spawn } from 'bun-pty';
import type { ImpSessionRequest, ResumeResult } from '../imp-port';
import type { ImpdExecRefusal, ImpdSessionOutput } from '../impd-contract';
import { mergeTail } from './merge-tail';
import type { StubConnection, StubImp, StubProcess } from './stub-imp';
import type { StubImpCommands } from './stub-imp-commands';
import type { StubImpFleet } from './stub-imp-fleet';

// What impd does with the next session requests instead of answering them,
// which a test sets.
export interface StubSessionFaults {
  // How many of the next session requests impd drops before it answers,
  // and the close code it drops them with.
  drops: { count: number; closeCode: number };

  // A refusal outside impd's contract that the next session request gets
  // instead, or null.
  nextMalformedFailure: { readonly code: string; readonly data: unknown } | null;

  // A refusal the next session request gets instead of an answer, with the
  // message it carries when it has one of its own.
  nextFailure: {
    readonly refusal: ImpdExecRefusal;
    readonly message?: string;
  } | null;

  // Whether the broker fails in every imp, as a CA that did not install
  // leaves it.
  brokerFailing: boolean;
}

// What a session's agent carries, read when the answer goes out.
interface StubSessionSettings {
  readonly continuity: 'offsets' | 'none';
  readonly resumeOverlap: number;
}

export interface StubSessionContext {
  readonly faults: StubSessionFaults;
  readonly fleet: StubImpFleet;
  readonly commands: StubImpCommands;
  readonly settings: StubSessionSettings;
}

// impd keeps exactly this many bytes of each generation's output.
const RING_BYTES = 262_144;

// The mode bytes a fresh attach sends ahead of a ring that has wrapped.
const PRELUDE = '\u001B[0m';

// impd's answer to a session request that reached it: a fault a test set, a
// refusal, or a process started or joined and attached to the connection.
export function answerStubSession(
  context: StubSessionContext,
  request: ImpSessionRequest,
  connection: StubConnection,
): void {
  if (connection.finished) {
    return;
  }

  const faults = context.faults;

  if (faults.drops.count > 0) {
    faults.drops.count -= 1;

    connection.stop({
      kind: 'closed',
      reason: `code ${faults.drops.closeCode}`,
      closeCode: faults.drops.closeCode,
    });

    return;
  }

  const malformed = faults.nextMalformedFailure;

  if (malformed !== null) {
    faults.nextMalformedFailure = null;

    connection.stopMalformed({
      kind: 'failed',
      code: malformed.code,
      message: `impd refused the session (${malformed.code})`,
      data: malformed.data,
    });

    return;
  }

  const failure = faults.nextFailure;

  if (failure !== null) {
    faults.nextFailure = null;

    connection.stop({
      kind: 'failed',
      message: failure.message ?? `impd refused the session (${failure.refusal.code})`,
      ...failure.refusal,
    });

    return;
  }

  const imp = context.fleet.imps.get(request.name);

  if (imp === undefined) {
    connection.stop({
      kind: 'failed',
      code: 'NOT_FOUND',
      message: `no imp ${request.name}`,
      data: { kind: 'imp', name: request.name },
    });

    return;
  }

  if (imp.state !== 'running' && request.kind === 'attach' && !request.wake) {
    connection.stop({
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

  context.fleet.updateAwake(imp);

  const running = imp.sessions.get(request.session);
  const brokerProblem = findBrokerProblem(faults, imp, request, running);

  if (brokerProblem !== null) {
    connection.stop({
      kind: 'failed',
      code: 'PRECONDITION_FAILED',
      message: `the broker is not ready in imp ${imp.name}`,
      data: { reason: 'broker_not_ready', detail: brokerProblem },
    });

    return;
  }

  if (running === undefined && request.kind === 'attach') {
    const previous = imp.previous.get(request.session);

    connection.stop({
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

  const proc = running ?? startProcess(context.commands, imp, request);

  if (proc === null) {
    return;
  }

  attachProcess(context.settings, {
    imp,
    proc,
    request,
    connection,
    created: running === undefined,
  });
}

// An attach carries no requirements in impd's exec protocol, so only a start
// can fail one.
function findBrokerProblem(
  faults: StubSessionFaults,
  imp: StubImp,
  request: ImpSessionRequest,
  running: StubProcess | undefined,
): string | null {
  if (request.kind !== 'start' || request.require?.includes('broker') !== true) {
    return null;
  }

  if (faults.brokerFailing) {
    return 'the broker CA did not install';
  }

  if (imp.grants.size === 0) {
    return 'the imp holds no grant';
  }

  const overridden = Object.keys(request.env).find((key) => isBrokerVariable(key));

  if (overridden !== undefined) {
    return overridden;
  }

  return running !== undefined && !running.requireBroker
    ? 'the session did not start with the broker required'
    : null;
}

function startProcess(
  commands: StubImpCommands,
  imp: StubImp,
  request: ImpSessionRequest,
): StubProcess | null {
  if (request.kind !== 'start') {
    return null;
  }

  const pty = spawn(request.argv[0] ?? 'false', request.argv.slice(1), {
    name: 'xterm-256color',
    cols: request.cols,
    rows: request.rows,
    cwd: commands.resolveGuestCwd(request.cwd) ?? request.cwd,
    env: { ...request.env, ...(commands.homeDir === null ? {} : { HOME: commands.homeDir }) },
  });

  const proc: StubProcess = {
    pty,
    generation: randomBytes(16).toString('hex'),
    argv: [...request.argv],
    ring: new Uint8Array(0),
    end: 0,
    exited: null,
    ended: false,
    connection: null,
    requireBroker: request.require?.includes('broker') === true,
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
      connection.stop({ kind: 'exit', code: exitCode, signal: null, offset: proc.end });
    }
  });

  return proc;
}

// Calls a connection's handler as the imp client does: a handler that
// throws ends the connection with a local error and closes it.
function tryEmit(connection: StubConnection, emit: () => void): boolean {
  try {
    emit();

    return true;
  } catch (error) {
    connection.stop({
      kind: 'local_error',
      detail: error instanceof Error ? error.message : String(error),
    });

    return false;
  }
}

// A process and the connection it attaches to, with whether the request
// started the process.
interface StubAttach {
  readonly imp: StubImp;
  readonly proc: StubProcess;
  readonly request: ImpSessionRequest;
  readonly connection: StubConnection;
  readonly created: boolean;
}

function attachProcess(settings: StubSessionSettings, attach: StubAttach): void {
  const imp = attach.imp;
  const proc = attach.proc;
  const request = attach.request;
  const connection = attach.connection;
  const created = attach.created;
  const bufferStart = proc.end - proc.ring.length;
  let from = bufferStart;
  let prelude = '';
  let resume: ResumeResult | undefined;

  if (request.resumeFrom !== undefined && settings.continuity === 'offsets') {
    const resumeFrom = request.resumeFrom;

    if (resumeFrom.executionGeneration !== proc.generation) {
      resume = {
        kind: 'generation_changed',
        executionGeneration: proc.generation,
        firstOffset: bufferStart,
      };
    } else if (resumeFrom.offset > proc.end) {
      connection.stop({
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
      from = Math.max(bufferStart, resumeFrom.offset - settings.resumeOverlap);
    }
  } else if (bufferStart > 0) {
    // A ring that has wrapped can start inside an escape sequence, so a
    // fresh attach skips to the next line and resets the modes first.
    const newline = proc.ring.indexOf(0x0a);

    from = bufferStart + (newline === -1 ? 0 : newline + 1);
    prelude = PRELUDE;
  }

  proc.connection?.stop({
    kind: 'detached',
    reason: 'taken_over',
    offset: proc.connection.sent,
  });

  connection.process = proc;
  connection.sent = proc.end;

  const preludeBytes = new TextEncoder().encode(prelude);

  const previous = imp.previous.get(request.session);

  const started = tryEmit(connection, () => {
    const output: ImpdSessionOutput =
      settings.continuity === 'none'
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
          };

    connection.handlers.onStarted({ created, output });
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
    const name = findSessionName(imp, proc);

    if (name !== undefined) {
      imp.sessions.delete(name);
    }

    connection.stop({ kind: 'exit', code: proc.exited.code, signal: null, offset: proc.end });

    return;
  }

  proc.connection = connection;
}

function findSessionName(imp: StubImp, proc: StubProcess): string | undefined {
  for (const [name, held] of imp.sessions) {
    if (held === proc) {
      return name;
    }
  }

  return undefined;
}
