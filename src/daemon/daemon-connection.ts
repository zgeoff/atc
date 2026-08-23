import { basename } from 'node:path';
import type { AgentAdapter, AgentID, SpawnOptions } from '../agents/agent-adapter';
import { OutboundQueue } from '../protocol/outbound-queue';
import type { SocketWriter } from '../protocol/outbound-queue';
import { parseRequestParams } from '../protocol/parse-request-params';
import {
  MAX_CHUNK,
  MAX_LINE,
  PROTOCOL_V,
  decodeMessage,
  encodeMessage,
} from '../protocol/protocol';
import type { ErrorCode, EventMsg, RequestMsg } from '../protocol/protocol';
import type { SessionID } from '../shared/session-id';
import type { FleetEntry } from '../store/fleet-entry';
import type { Dims } from './attach-registry';
import type { AnswerResult } from './permission-registry';
import type { SessionDescriptor } from './sessions';

interface SpawnParams {
  readonly cwd: string;
  readonly name: string;
  readonly prompt: string;
  readonly cols: number;
  readonly rows: number;
  readonly resume: SpawnOptions['resume'];
  readonly namedBy: 'user' | 'auto';
  readonly agent: AgentID;
}

export interface DaemonContext {
  readonly build: string;
  readonly collectSessions: () => SessionDescriptor[];
  readonly collectSpawnDirs: () => Promise<string[]>;
  readonly collectFleet: () => Promise<FleetEntry[]>;
  readonly loadLastUsedAgent: () => Promise<AgentID>;
  readonly findAdapter: (id: AgentID) => AgentAdapter | null;
  readonly spawnSession: (p: SpawnParams) => SessionDescriptor;
  readonly killSession: (id: SessionID) => Promise<boolean>;
  readonly updateSession: (id: SessionID, name?: string, pinned?: boolean) => boolean;
  readonly quitDaemon: () => void;
  readonly ackSession: (id: SessionID) => boolean;
  readonly buildResumeCommand: (id: SessionID) => string | null;
  readonly answerPermission: (request: string, decision: string) => AnswerResult;
  readonly restoreFleet: (cols: number, rows: number) => Promise<number>;
  readonly attachSession: (
    client: OutputClient,
    sessionID: SessionID,
    dims: Dims,
  ) => 'ok' | 'missing' | 'dead';
  readonly detachSession: (client: OutputClient, sessionID: SessionID) => void;
  readonly detachClient: (client: OutputClient) => void;
  readonly writeSessionInput: (
    sessionID: SessionID,
    data: string,
  ) => 'busy' | 'ok' | 'missing' | 'dead';
  readonly ejectSession: (
    id: SessionID,
    prompt: string,
  ) => 'ok' | 'missing' | 'unsupported' | 'no_transcript';
  readonly adoptSession: (
    id: SessionID,
    cols: number,
    rows: number,
  ) => 'ok' | 'missing' | 'no_transcript';
  readonly resizeSession: (client: OutputClient, sessionID: SessionID, dims: Dims) => boolean;
  readonly resyncClient: (sessionID: SessionID, client: OutputClient) => Promise<void>;
  readonly queueBytes?: number;
  readonly getEffectiveDims: (sessionID: SessionID) => Dims;
}

// The slice of a connection the attach bookkeeping needs: identity plus the
// ability to receive output events.
export interface OutputClient {
  readonly sendOutput: (sessionID: SessionID, event: EventMsg, byteLength: number) => void;
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

  // The handshake answer is written before any other response on this
  // connection, even though building it reads the store: a request that
  // arrives while that read is in flight waits behind it.
  private helloAnswered: Promise<void> = Promise.resolve();

  private readonly desynced = new Map<SessionID, number>();

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
  sendOutput(sessionID: SessionID, event: EventMsg, byteLength: number): void {
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

    this.answerAsync(req.id, () => this.applyRequest(req));

    return true;
  }

  // A store query that rejects must end one request, never the daemon: a
  // floating promise here would take the whole process down with it.
  private answerAsync(id: number, answered: () => Promise<void>): void {
    void (async () => {
      try {
        await answered();
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);

        this.sendErr(id, 'internal', reason);
      }
    })();
  }

  private async applyRequest(req: RequestMsg): Promise<void> {
    await this.helloAnswered;

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
        this.sendOk(req.id, { dirs: await this.ctx.collectSpawnDirs() });

        return;
      }
      case 'fleet.list': {
        this.sendOk(req.id, { fleet: await this.ctx.collectFleet() });

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
        const parsed = parseRequestParams('session.update', req.p);

        if (!parsed.ok) {
          this.sendErr(req.id, 'bad_args', parsed.message);

          return;
        }

        const sessionID = parsed.data.session;

        if (this.ctx.updateSession(sessionID, parsed.data.name, parsed.data.pinned)) {
          this.sendOk(req.id, {});
        } else {
          this.sendErr(req.id, 'no_such_session', `no session '${sessionID}'`);
        }

        return;
      }
      case 'session.kill': {
        await this.applySessionVerb(req, 'session.kill', this.ctx.killSession);

        return;
      }
      case 'session.ack': {
        await this.applySessionVerb(req, 'session.ack', this.ctx.ackSession);

        return;
      }
      case 'session.resumeCommand': {
        const parsed = parseRequestParams('session.resumeCommand', req.p);

        if (!parsed.ok) {
          this.sendErr(req.id, 'bad_args', parsed.message);

          return;
        }

        const id = parsed.data.session;
        const command = this.ctx.buildResumeCommand(id);

        if (command === null) {
          this.sendErr(req.id, 'no_such_session', `no session '${id}'`);
        } else {
          this.sendOk(req.id, { command });
        }

        return;
      }
      case 'session.eject': {
        const parsed = parseRequestParams('session.eject', req.p);

        if (!parsed.ok) {
          this.sendErr(req.id, 'bad_args', parsed.message);

          return;
        }

        const sessionID = parsed.data.session;
        const result = this.ctx.ejectSession(sessionID, parsed.data.prompt);

        if (result === 'ok') {
          this.sendOk(req.id, {});
        } else if (result === 'unsupported') {
          this.sendErr(req.id, 'unsupported', "this session's agent has no headless handoff");
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
        const parsed = parseRequestParams('session.adopt', req.p);

        if (!parsed.ok) {
          this.sendErr(req.id, 'bad_args', parsed.message);

          return;
        }

        const sessionID = parsed.data.session;
        const adoptResult = this.ctx.adoptSession(sessionID, parsed.data.cols, parsed.data.rows);

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
        const parsed = parseRequestParams('session.detach', req.p);

        if (!parsed.ok) {
          this.sendErr(req.id, 'bad_args', parsed.message);

          return;
        }

        this.ctx.detachSession(this, parsed.data.session);
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
        const parsed = parseRequestParams('fleet.restore', req.p);

        if (!parsed.ok) {
          this.sendErr(req.id, 'bad_args', parsed.message);

          return;
        }

        this.sendOk(req.id, {
          restored: await this.ctx.restoreFleet(parsed.data.cols, parsed.data.rows),
        });

        return;
      }
      default: {
        this.sendErr(req.id, 'unknown_method', `unknown method '${req.m}'`);
      }
    }
  }

  private applySpawn(req: RequestMsg): void {
    const parsed = parseRequestParams('session.spawn', req.p);

    if (!parsed.ok) {
      this.sendErr(req.id, 'bad_args', parsed.message);

      return;
    }

    const cwd = parsed.data.cwd;
    const name = parsed.data.name;
    const agent: AgentID = parsed.data.agent ?? 'claude';

    if (this.ctx.findAdapter(agent) === null) {
      this.sendErr(req.id, 'unsupported', `no adapter for agent '${agent}'`);

      return;
    }

    const session = this.ctx.spawnSession({
      cwd,
      name: name === '' ? basename(cwd) : name,
      prompt: parsed.data.prompt,
      cols: parsed.data.cols,
      rows: parsed.data.rows,
      resume: parsed.data.resume,
      namedBy: name === '' ? 'auto' : 'user',
      agent,
    });

    this.sendOk(req.id, { session });
  }

  private applyAttach(req: RequestMsg): void {
    const parsed = parseRequestParams('session.attach', req.p);

    if (!parsed.ok) {
      this.sendErr(req.id, 'bad_args', parsed.message);

      return;
    }

    const sessionID = parsed.data.session;

    const result = this.ctx.attachSession(this, sessionID, {
      cols: parsed.data.cols,
      rows: parsed.data.rows,
    });

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
    const parsed = parseRequestParams('session.input', req.p);

    if (!parsed.ok) {
      this.sendErr(req.id, 'bad_args', parsed.message);

      return;
    }

    const sessionID = parsed.data.session;
    const result = this.ctx.writeSessionInput(sessionID, parsed.data.d);

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
    const parsed = parseRequestParams('session.resize', req.p);

    if (!parsed.ok) {
      this.sendErr(req.id, 'bad_args', parsed.message);

      return;
    }

    const sessionID = parsed.data.session;

    if (
      !this.ctx.resizeSession(this, sessionID, { cols: parsed.data.cols, rows: parsed.data.rows })
    ) {
      this.sendErr(req.id, 'bad_args', `not attached to session '${sessionID}'`);

      return;
    }

    this.sendOk(req.id, {});
  }

  private applyPermissionRespond(req: RequestMsg): void {
    const parsed = parseRequestParams('permission.respond', req.p);

    if (!parsed.ok) {
      this.sendErr(req.id, 'bad_args', parsed.message);

      return;
    }

    const request = parsed.data.request;
    const decision = parsed.data.decision;
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

  private async applySessionVerb(
    req: RequestMsg,
    method: 'session.kill' | 'session.ack',
    verb: (id: SessionID) => boolean | Promise<boolean>,
  ): Promise<void> {
    const parsed = parseRequestParams(method, req.p);

    if (!parsed.ok) {
      this.sendErr(req.id, 'bad_args', parsed.message);

      return;
    }

    const id = parsed.data.session;

    const ok = await verb(id);

    if (ok) {
      this.sendOk(req.id, {});
    } else {
      this.sendErr(req.id, 'no_such_session', `no session '${id}'`);
    }
  }

  private applyHello(req: RequestMsg): boolean {
    const parsedHello = parseRequestParams('daemon.hello', req.p);
    const client = parsedHello.ok ? parsedHello.data.client : 'unknown client';

    if (req.v !== PROTOCOL_V) {
      this.sendErr(
        req.id,
        'protocol_mismatch',
        `${client} speaks protocol v${req.v}, daemon ${this.ctx.build} speaks v${PROTOCOL_V}; restart the daemon so both run the same build`,
      );

      return false;
    }

    this.helloed = true;
    this.helloAnswered = this.sendHelloOk(req.id);

    this.answerAsync(req.id, () => this.helloAnswered);

    return true;
  }

  private async sendHelloOk(id: number): Promise<void> {
    this.sendOk(id, {
      daemon: this.ctx.build,
      limits: { maxLine: MAX_LINE, maxChunk: MAX_CHUNK },
      lastUsedAgent: await this.ctx.loadLastUsedAgent(),
    });
  }

  private sendOk(id: number, ok: Readonly<Record<string, unknown>>): void {
    this.queue.send(encodeMessage({ v: PROTOCOL_V, id, ok }));
  }

  private sendErr(id: number, code: ErrorCode, msg: string): void {
    this.queue.send(encodeMessage({ v: PROTOCOL_V, id, err: { code, msg } }));
  }
}
