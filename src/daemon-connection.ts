import { basename } from 'node:path';
import type { Dims } from './attach-registry';
import { OutboundQueue } from './outbound-queue';
import type { SocketWriter } from './outbound-queue';
import type { AnswerResult } from './permission-registry';
import { MAX_CHUNK, MAX_LINE, PROTOCOL_V, decodeMessage, encodeMessage } from './protocol';
import type { ErrorCode, EventMsg, RequestMsg } from './protocol';
import type { FleetEntry, SessionDescriptor } from './sessions';

interface SpawnParams {
  readonly cwd: string;
  readonly name: string;
  readonly prompt: string;
  readonly cols: number;
  readonly rows: number;
  readonly resume: boolean | string;
  readonly namedBy: 'user' | 'auto';
}

export interface DaemonContext {
  readonly build: string;
  readonly collectSessions: () => SessionDescriptor[];
  readonly collectSpawnDirs: () => string[];
  readonly collectFleet: () => FleetEntry[];
  readonly spawnSession: (p: SpawnParams) => SessionDescriptor;
  readonly killSession: (id: string) => boolean;
  readonly updateSession: (id: string, name?: string, pinned?: boolean) => boolean;
  readonly quitDaemon: () => void;
  readonly ackSession: (id: string) => boolean;
  readonly buildResumeCommand: (id: string) => string | null;
  readonly answerPermission: (request: string, decision: string) => AnswerResult;
  readonly restoreFleet: (cols: number, rows: number) => number;
  readonly attachSession: (
    client: OutputClient,
    sessionID: string,
    dims: Dims,
  ) => 'ok' | 'missing' | 'dead';
  readonly detachSession: (client: OutputClient, sessionID: string) => void;
  readonly detachClient: (client: OutputClient) => void;
  readonly writeSessionInput: (
    sessionID: string,
    data: string,
  ) => 'busy' | 'ok' | 'missing' | 'dead';
  readonly ejectSession: (
    id: string,
    prompt: string,
  ) => 'ok' | 'missing' | 'unsupported' | 'no_transcript';
  readonly adoptSession: (
    id: string,
    cols: number,
    rows: number,
  ) => 'ok' | 'missing' | 'no_transcript';
  readonly resizeSession: (client: OutputClient, sessionID: string, dims: Dims) => boolean;
  readonly resyncClient: (sessionID: string, client: OutputClient) => Promise<void>;
  readonly queueBytes?: number;
  readonly getEffectiveDims: (sessionID: string) => Dims;
}

// The slice of a connection the attach bookkeeping needs: identity plus the
// ability to receive output events.
export interface OutputClient {
  readonly sendOutput: (sessionID: string, event: EventMsg, byteLength: number) => void;
}

interface PeerSocket extends SocketWriter {
  readonly end: () => void;
}

export class DaemonConnection {
  private readonly peer: PeerSocket;

  private readonly ctx: DaemonContext;

  private readonly queue: OutboundQueue;

  private buffer = '';

  private helloed = false;

  private readonly desynced = new Map<string, number>();

  constructor(peer: PeerSocket, ctx: DaemonContext) {
    this.peer = peer;
    this.ctx = ctx;

    this.queue = new OutboundQueue(peer, ctx.queueBytes);
  }

  sendEvent(event: EventMsg): void {
    if (this.helloed && !this.queue.send(encodeMessage(event))) {
      this.peer.end();
    }
  }

  // Output is droppable: an overflow discards this session's backlog for
  // this client and resynchronizes with a repaint once the queue drains. An
  // intermediate chunk is never dropped without that resync, because a byte
  // stream cut mid-escape corrupts the client's terminal state.
  sendOutput(sessionID: string, event: EventMsg, byteLength: number): void {
    if (!this.helloed) {
      return;
    }

    const dropped = this.desynced.get(sessionID);

    if (dropped !== undefined) {
      this.desynced.set(sessionID, dropped + byteLength);

      return;
    }

    if (!this.queue.send(encodeMessage(event))) {
      this.desynced.set(sessionID, byteLength);
    }
  }

  applyChunk(chunk: string): void {
    const buffered = this.buffer + chunk;

    if (buffered.length > MAX_LINE) {
      this.sendErr(0, 'bad_args', `line exceeds ${MAX_LINE} bytes`);
      this.peer.end();

      return;
    }

    const lines = buffered.split('\n');

    this.buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (line.trim() === '') {
        continue;
      }

      if (!this.applyLine(line)) {
        this.peer.end();

        return;
      }
    }
  }

  drain(): void {
    this.queue.drain();

    if (this.queue.queuedBytes > 0 || this.desynced.size === 0) {
      return;
    }

    for (const [sessionID, dropped] of this.desynced) {
      this.desynced.delete(sessionID);
      this.sendEvent({ v: PROTOCOL_V, ev: 'session.desync', s: sessionID, dropped });
      void this.ctx.resyncClient(sessionID, this);
    }
  }

  // false: the connection is beyond recovery and gets closed.
  private applyLine(line: string): boolean {
    const decoded = decodeMessage(line);

    if (decoded.kind === 'malformed') {
      this.sendErr(0, 'bad_args', `malformed line: ${decoded.reason}`);

      return false;
    }

    if (decoded.kind !== 'request') {
      this.sendErr(0, 'bad_args', 'only requests flow client to daemon');

      return false;
    }

    const req = decoded.msg;

    if (req.m === 'daemon.hello') {
      return this.applyHello(req);
    }

    if (!this.helloed) {
      this.sendErr(req.id, 'unauthorized', 'daemon.hello must be the first request');

      return false;
    }

    this.applyRequest(req);

    return true;
  }

  private applyRequest(req: RequestMsg): void {
    switch (req.m) {
      case 'daemon.ping': {
        this.sendOk(req.id, {});

        return;
      }
      case 'session.list': {
        this.sendOk(req.id, { sessions: this.ctx.collectSessions() });

        return;
      }
      case 'dirs.list': {
        this.sendOk(req.id, { dirs: this.ctx.collectSpawnDirs() });

        return;
      }
      case 'fleet.list': {
        this.sendOk(req.id, { fleet: this.ctx.collectFleet() });

        return;
      }
      case 'session.spawn': {
        this.applySpawn(req);

        return;
      }
      case 'daemon.quit': {
        this.sendOk(req.id, {});
        this.ctx.quitDaemon();

        return;
      }
      case 'session.update': {
        const sessionID = typeof req.p?.['session'] === 'string' ? req.p['session'] : '';
        const name = typeof req.p?.['name'] === 'string' ? req.p['name'] : undefined;
        const pinned = typeof req.p?.['pinned'] === 'boolean' ? req.p['pinned'] : undefined;

        if (this.ctx.updateSession(sessionID, name, pinned)) {
          this.sendOk(req.id, {});
        } else {
          this.sendErr(req.id, 'no_such_session', `no session '${sessionID}'`);
        }

        return;
      }
      case 'session.kill': {
        this.applySessionVerb(req, this.ctx.killSession);

        return;
      }
      case 'session.ack': {
        this.applySessionVerb(req, this.ctx.ackSession);

        return;
      }
      case 'session.resumeCommand': {
        const id = typeof req.p?.['session'] === 'string' ? req.p['session'] : '';
        const command = this.ctx.buildResumeCommand(id);

        if (command === null) {
          this.sendErr(req.id, 'no_such_session', `no session '${id}'`);
        } else {
          this.sendOk(req.id, { command });
        }

        return;
      }
      case 'session.eject': {
        const sessionID = typeof req.p?.['session'] === 'string' ? req.p['session'] : '';

        const prompt =
          typeof req.p?.['prompt'] === 'string' && req.p['prompt'] !== ''
            ? req.p['prompt']
            : 'Continue the task autonomously. Verify your work as you go and stop when it is complete.';

        const result = this.ctx.ejectSession(sessionID, prompt);

        if (result === 'ok') {
          this.sendOk(req.id, {});
        } else if (result === 'unsupported') {
          this.sendErr(req.id, 'unsupported', 'this daemon has no headless runner');
        } else if (result === 'no_transcript') {
          this.sendErr(
            req.id,
            'session_dead',
            'nothing to resume yet — the session has no saved transcript',
          );
        } else {
          this.sendErr(
            req.id,
            'no_such_session',
            `session '${sessionID}' has no live terminal with a captured agent session id`,
          );
        }

        return;
      }
      case 'session.adopt': {
        const sessionID = typeof req.p?.['session'] === 'string' ? req.p['session'] : '';
        const cols = typeof req.p?.['cols'] === 'number' ? req.p['cols'] : 80;
        const rows = typeof req.p?.['rows'] === 'number' ? req.p['rows'] : 24;
        const adoptResult = this.ctx.adoptSession(sessionID, cols, rows);

        if (adoptResult === 'ok') {
          this.sendOk(req.id, {});
        } else if (adoptResult === 'no_transcript') {
          this.sendErr(
            req.id,
            'session_dead',
            'nothing to resume yet — the session has no saved transcript',
          );
        } else {
          this.sendErr(
            req.id,
            'no_such_session',
            `session '${sessionID}' is not a dead or headless session with a captured agent session id`,
          );
        }

        return;
      }
      case 'session.attach': {
        this.applyAttach(req);

        return;
      }
      case 'session.detach': {
        const sessionID = typeof req.p?.['session'] === 'string' ? req.p['session'] : '';

        this.ctx.detachSession(this, sessionID);
        this.sendOk(req.id, {});

        return;
      }
      case 'session.input': {
        this.applyInput(req);

        return;
      }
      case 'session.resize': {
        this.applyResize(req);

        return;
      }
      case 'permission.respond': {
        this.applyPermissionRespond(req);

        return;
      }
      case 'fleet.restore': {
        const cols = typeof req.p?.['cols'] === 'number' ? req.p['cols'] : 80;
        const rows = typeof req.p?.['rows'] === 'number' ? req.p['rows'] : 24;

        this.sendOk(req.id, { restored: this.ctx.restoreFleet(cols, rows) });

        return;
      }
      default: {
        this.sendErr(req.id, 'unknown_method', `unknown method '${req.m}'`);
      }
    }
  }

  private applySpawn(req: RequestMsg): void {
    const cwd = req.p?.['cwd'];

    if (typeof cwd !== 'string' || cwd === '') {
      this.sendErr(req.id, 'bad_args', 'session.spawn requires a cwd');

      return;
    }

    const name = typeof req.p?.['name'] === 'string' ? req.p['name'] : '';
    const rawResume = req.p?.['resume'];
    let resume: boolean | string = false;

    if (typeof rawResume === 'boolean' || typeof rawResume === 'string') {
      resume = rawResume;
    }

    const session = this.ctx.spawnSession({
      cwd,
      name: name === '' ? basename(cwd) : name,
      prompt: typeof req.p?.['prompt'] === 'string' ? req.p['prompt'] : '',
      cols: typeof req.p?.['cols'] === 'number' ? req.p['cols'] : 80,
      rows: typeof req.p?.['rows'] === 'number' ? req.p['rows'] : 24,
      resume,
      namedBy: name === '' ? 'auto' : 'user',
    });

    this.sendOk(req.id, { session });
  }

  private applyAttach(req: RequestMsg): void {
    const sessionID = typeof req.p?.['session'] === 'string' ? req.p['session'] : '';
    const cols = typeof req.p?.['cols'] === 'number' ? req.p['cols'] : 80;
    const rows = typeof req.p?.['rows'] === 'number' ? req.p['rows'] : 24;
    const result = this.ctx.attachSession(this, sessionID, { cols, rows });

    if (result === 'missing') {
      this.sendErr(req.id, 'no_such_session', `no session '${sessionID}'`);

      return;
    }

    if (result === 'dead') {
      this.sendErr(req.id, 'session_dead', `session '${sessionID}' has no live process`);

      return;
    }

    const dims = this.ctx.getEffectiveDims(sessionID);

    this.sendOk(req.id, { cols: dims.cols, rows: dims.rows });
  }

  private applyInput(req: RequestMsg): void {
    const sessionID = typeof req.p?.['session'] === 'string' ? req.p['session'] : '';
    const data = typeof req.p?.['d'] === 'string' ? req.p['d'] : '';
    const result = this.ctx.writeSessionInput(sessionID, data);

    if (result === 'missing') {
      this.sendErr(req.id, 'no_such_session', `no session '${sessionID}'`);

      return;
    }

    if (result === 'dead') {
      this.sendErr(req.id, 'session_dead', `session '${sessionID}' has no live process`);

      return;
    }

    if (result === 'busy') {
      this.sendErr(
        req.id,
        'too_slow',
        `session '${sessionID}' is mid-run; wait for the turn to end`,
      );

      return;
    }

    this.sendOk(req.id, {});
  }

  private applyResize(req: RequestMsg): void {
    const sessionID = typeof req.p?.['session'] === 'string' ? req.p['session'] : '';
    const cols = typeof req.p?.['cols'] === 'number' ? req.p['cols'] : 0;
    const rows = typeof req.p?.['rows'] === 'number' ? req.p['rows'] : 0;

    if (cols < 1 || rows < 1) {
      this.sendErr(req.id, 'bad_args', 'session.resize requires positive cols and rows');

      return;
    }

    if (!this.ctx.resizeSession(this, sessionID, { cols, rows })) {
      this.sendErr(req.id, 'bad_args', `not attached to session '${sessionID}'`);

      return;
    }

    this.sendOk(req.id, {});
  }

  private applyPermissionRespond(req: RequestMsg): void {
    const request = typeof req.p?.['request'] === 'string' ? req.p['request'] : '';
    const decision = typeof req.p?.['decision'] === 'string' ? req.p['decision'] : '';

    if (request === '' || decision === '') {
      this.sendErr(req.id, 'bad_args', 'permission.respond requires a request and a decision');

      return;
    }

    const result = this.ctx.answerPermission(request, decision);

    switch (result) {
      case 'ok': {
        this.sendOk(req.id, {});

        return;
      }
      case 'already_answered': {
        this.sendErr(req.id, 'already_answered', `request '${request}' was already answered`);

        return;
      }
      case 'unsupported': {
        this.sendErr(req.id, 'unsupported', `request '${request}' is answered with keystrokes`);

        return;
      }
      case 'unknown': {
        this.sendErr(req.id, 'bad_args', `unknown permission request '${request}'`);
      }
    }
  }

  private applySessionVerb(req: RequestMsg, verb: (id: string) => boolean): void {
    const id = typeof req.p?.['session'] === 'string' ? req.p['session'] : '';

    if (verb(id)) {
      this.sendOk(req.id, {});
    } else {
      this.sendErr(req.id, 'no_such_session', `no session '${id}'`);
    }
  }

  private applyHello(req: RequestMsg): boolean {
    const client = typeof req.p?.['client'] === 'string' ? req.p['client'] : 'unknown client';

    if (req.v !== PROTOCOL_V) {
      this.sendErr(
        req.id,
        'protocol_mismatch',
        `${client} speaks protocol v${req.v}, daemon ${this.ctx.build} speaks v${PROTOCOL_V}; restart the daemon so both run the same build`,
      );

      return false;
    }

    this.helloed = true;

    this.sendOk(req.id, {
      daemon: this.ctx.build,
      limits: { maxLine: MAX_LINE, maxChunk: MAX_CHUNK },
    });

    return true;
  }

  private sendOk(id: number, ok: Readonly<Record<string, unknown>>): void {
    this.queue.send(encodeMessage({ v: PROTOCOL_V, id, ok }));
  }

  private sendErr(id: number, code: ErrorCode, msg: string): void {
    this.queue.send(encodeMessage({ v: PROTOCOL_V, id, err: { code, msg } }));
  }
}
