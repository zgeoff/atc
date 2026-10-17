import { basename, isAbsolute } from 'node:path';
import type { AgentID, SessionID } from '@atc/core';
import { toSessionID } from '@atc/core';
import type { SourceProvider, SourceRequest } from '@atc/plugin-api';
import {
  CONTROL_CHARACTER,
  DAEMON_FEATURES,
  REQUEST_PARAM_SCHEMAS,
  decodeCursor,
  encodeCursor,
  parseDeclaredScope,
  parseRequestParams,
} from '@atc/protocol';
import type { DaemonAnswer, DeclaredScope, RequestMethod } from '@atc/protocol';
import {
  DaemonError,
  LineDecoder,
  MAX_CHUNK,
  MAX_LINE,
  OutboundQueue,
  PROTOCOL_V,
  decodeMessage,
  encodeMessage,
} from '@atc/protocol/wire';
import type { ErrorCode, EventMsg, RequestMsg, SocketWriter } from '@atc/protocol/wire';
import { match } from 'ts-pattern';
import { buildScopedContext } from '../auth/build-scoped-context';
import { buildTargetForbiddenError } from '../auth/build-target-forbidden-error';
import { isOwnerOnlyMethod } from '../auth/is-owner-only-method';
import { TargetAccess } from '../auth/target-access';
import type { DaemonContext, SpawnParams } from '../daemon-context';
import type { TranscriptPosition } from '../sessions/load-transcript-page';
import type { MessageCaller } from '../sessions/message-caller';
import { parseSpawnOverrides } from '../sessions/parse-spawn-overrides';
import { buildLegacyMessageHashes } from './build-legacy-message-hashes';
import { buildPayloadHash } from './build-payload-hash';
import { checkTCPHello } from './check-tcp-hello';
import { ConnectionView } from './connection-view';
import type { KeyedRequest } from './idempotency-ledger';
import type { TCPPeer } from './tcp-peer';

// The targets a request may use and the namespace of its idempotency keys.
interface RequestScope {
  readonly access: TargetAccess;
  readonly keyNamespace: string;
}

// What a source request holds: the source's id and the target it is for.
interface SourceParams {
  readonly source: string;
  readonly target?: string | undefined;
}

// The source a request asks for, and the request the source serves.
interface ResolvedSourceRequest {
  readonly source: SourceProvider;
  readonly request: SourceRequest;
}

interface PeerSocket extends SocketWriter {
  readonly end: () => void;
}

export class DaemonConnection {
  private readonly peer: PeerSocket;

  private readonly ctx: DaemonContext;

  private readonly queue: OutboundQueue;

  private readonly lines = new LineDecoder();

  private helloed = false;

  // The handshake answer is written before any other response on this
  // connection, even though building it reads the store: a request that
  // arrives while that read is in flight waits behind it.
  private helloAnswered: Promise<void> = Promise.resolve();

  private readonly desynced = new Map<SessionID, number>();

  // The principal the whole connection acts as, from its handshake, and the
  // targets that principal may use; null for the daemon's owner, whose
  // reach has no limit.
  private principal: string | null = null;

  private access: TargetAccess | null = null;

  // The atc session the client runs inside; null for the owner. The kernel's answer binds it
  // on the local socket, and a handshake gives it only for a process in no session. A session
  // never changes its own or an ancestor's record through it, and sends every message as it.
  private callerSession: SessionID | null = null;

  // The session the kernel found the connecting process in, by the pid it
  // holds for the local socket's peer; null on TCP, for a process outside
  // every session, and on a platform the daemon cannot ask.
  private readonly peerSession: SessionID | null;

  // The client name the handshake gives, such as an atc build or the name
  // of another program.
  private helloClient = 'unknown client';

  // What this connection sees of the fleet while its access is limited.
  private readonly view: ConnectionView;

  // The listener of a connection accepted over TCP, null on the local
  // socket.
  private readonly tcp: TCPPeer | null;

  // The fingerprint of the token a TCP handshake presented, set once the
  // handshake passes; null before then and on the local socket.
  private fingerprint: string | null = null;

  // Whether this TCP connection has sent its one handshake.
  private tcpHelloSent = false;

  constructor(
    peer: PeerSocket,
    ctx: DaemonContext,
    tcp: TCPPeer | null = null,
    peerSession: SessionID | null = null,
  ) {
    this.peer = peer;
    this.ctx = ctx;
    this.tcp = tcp;
    this.peerSession = peerSession;

    this.view = new ConnectionView(ctx);
    this.queue = new OutboundQueue(peer, ctx.queueBytes);

    // A TCP connection acts only as the principals its requests give, so
    // the events pushed to it are limited from the first byte.
    if (tcp !== null) {
      this.access = new TargetAccess([]);
    }
  }

  get tokenFingerprint(): string | null {
    return this.fingerprint;
  }

  // safe to call more than once
  dispose(): void {
    this.peer.end();
  }

  sendEvent(event: EventMsg): void {
    if (!this.hasPassedHello()) {
      return;
    }

    const view =
      this.access === null
        ? { events: [event], withdrawn: [] }
        : this.view.updateView(event, this.access);

    for (const visible of view.events) {
      if (!this.queue.send(encodeMessage(visible))) {
        this.peer.end();

        return;
      }
    }

    // Output and inbox messages of a session that left the view stop with
    // it. The detach runs once the view is settled, since it emits an event
    // of its own.
    for (const id of view.withdrawn) {
      this.desynced.delete(id);
      this.ctx.detachSession(this, id);
      this.ctx.detachTap(this, id);
    }
  }

  // An overflow drops this session's backlog for this client and resynchronizes with a repaint
  // once the queue drains. A chunk is never dropped without that resync, because a byte stream
  // cut mid-escape corrupts the client's terminal state.
  sendOutput(sessionID: SessionID, event: EventMsg, byteLength: number): void {
    if (!this.hasPassedHello() || !this.canSeeOutput(sessionID)) {
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

  // Whether the handshake has passed: on TCP, only once its token checked out.
  private hasPassedHello(): boolean {
    return this.helloed && (this.tcp === null || this.fingerprint !== null);
  }

  // Decodes with state kept across reads, so a multi-byte character split
  // between two reads decodes whole.
  decodeChunk(buf: Uint8Array): string {
    return this.lines.decodeText(buf);
  }

  applyChunk(chunk: string): void {
    const oversized = this.lines.pendingLength + chunk.length > MAX_LINE;

    if (oversized && this.isUnauthenticatedTCP()) {
      this.tcp?.recordFailure('line_too_long');
      this.peer.end();

      return;
    }

    if (oversized) {
      this.sendErr(0, 'bad_args', `line exceeds ${MAX_LINE} bytes`);
      this.peer.end();

      return;
    }

    for (const line of this.lines.splitText(chunk)) {
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

      if (this.canSeeOutput(sessionID)) {
        this.sendEvent({ v: PROTOCOL_V, ev: 'SessionDesync', s: sessionID, dropped });
        void this.ctx.resyncClient(sessionID, this);
      }
    }
  }

  // Whether this connection may receive the session's output: always for
  // the daemon's owner, and otherwise only while its view holds the
  // session's whole tree.
  private canSeeOutput(sessionID: SessionID): boolean {
    return this.access === null || this.ctx.canSeeSession(sessionID, this.access);
  }

  // false: the connection is beyond recovery and gets closed.
  private applyLine(line: string): boolean {
    if (this.tcp !== null) {
      const refused = this.findTCPLineRefusal(line);

      if (refused === 'close') {
        return false;
      }
    }

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
      return this.tcp === null ? this.applyHello(req) : this.applyTCPHello(req, this.tcp);
    }

    if (!this.helloed) {
      this.sendErr(req.id, 'unauthorized', 'daemon.hello must be the first request');

      return false;
    }

    if (this.tcp !== null) {
      this.answerAsync(req.id, () => this.applyTCPRequest(req));

      return true;
    }

    const scope = this.findRequestScope(req);

    if (scope !== null && isOwnerOnlyMethod(req.m)) {
      this.sendErr(req.id, 'unauthorized', `${req.m} is open to the daemon's owner only`);

      return true;
    }

    const ctx =
      scope === null ? this.ctx : buildScopedContext(this.ctx, scope.access, scope.keyNamespace);

    this.answerAsync(req.id, () => this.applyRequest(req, ctx));

    return true;
  }

  // Until its token checks out, a TCP connection gets nothing but the answer to one handshake,
  // so a peer learns nothing and floods nothing past the delay.
  private findTCPLineRefusal(line: string): 'close' | null {
    if (this.isUnauthenticatedTCP()) {
      const decoded = decodeMessage(line);
      const isHello = decoded.kind === 'request' && decoded.msg.m === 'daemon.hello';

      if (this.tcpHelloSent || !isHello) {
        this.tcp?.recordFailure('unexpected_line');

        return 'close';
      }

      this.tcpHelloSent = true;

      return null;
    }

    const decoded = decodeMessage(line);

    // a second handshake could change the principal under kept attachments
    if (decoded.kind === 'request' && decoded.msg.m === 'daemon.hello') {
      this.sendErr(decoded.msg.id, 'unauthorized', 'a TCP connection takes one handshake');

      return 'close';
    }

    return null;
  }

  // Whether this is a TCP connection whose handshake has not passed.
  private isUnauthenticatedTCP(): boolean {
    return this.tcp !== null && this.fingerprint === null;
  }

  // A request over TCP runs only once the handshake has passed, only as a
  // principal the config lists, and never as the daemon's owner, so it
  // always runs on the context scoped to that principal.
  private async applyTCPRequest(req: RequestMsg): Promise<void> {
    await this.helloAnswered;

    if (this.fingerprint === null) {
      return;
    }

    if (isOwnerOnlyMethod(req.m)) {
      this.sendErr(req.id, 'unauthorized', `${req.m} is open to the daemon's owner only`);

      return;
    }

    if (req.as === undefined) {
      this.sendErr(req.id, 'unauthorized', 'a request over TCP must act as a principal with as');

      return;
    }

    if (!this.ctx.hasListedPrincipal(req.as)) {
      this.tcp?.recordRefusedPrincipal();
      this.sendErr(req.id, 'unauthorized', `principal '${req.as}' is not listed in principals`);

      return;
    }

    const scope = this.findRequestScope(req);

    if (scope === null) {
      throw new DaemonError('internal', 'a request over TCP resolved to the owner scope');
    }

    await this.applyRequest(req, buildScopedContext(this.ctx, scope.access, scope.keyNamespace));
  }

  // Null is the daemon's owner. A connection that acts as a principal always keeps its own
  // idempotency keys, whatever principal a request acts as.
  private findRequestScope(req: RequestMsg): RequestScope | null {
    if (req.as === undefined) {
      return this.principal === null || this.access === null
        ? null
        : { access: this.access, keyNamespace: `client:${this.principal}` };
    }

    const access = this.ctx.buildTargetAccess(req.as);

    if (this.principal === null || this.access === null) {
      return { access, keyNamespace: `client:${req.as}` };
    }

    return { access: this.access.merge(access), keyNamespace: `client:${this.principal}` };
  }

  // A store query that rejects must end one request, never the daemon: a
  // floating promise here would take the whole process down with it. A
  // rejection that carries a protocol error code answers with that code.
  private answerAsync(id: number, answered: () => Promise<void>): void {
    void (async () => {
      try {
        await answered();
      } catch (error) {
        if (error instanceof DaemonError) {
          this.sendErr(id, error.code, error.message, error.data);

          return;
        }

        const reason = error instanceof Error ? error.message : String(error);

        this.sendErr(id, 'internal', reason);
      }
    })();
  }

  private async applyRequest(req: RequestMsg, ctx: DaemonContext): Promise<void> {
    await this.helloAnswered;

    if (!isRequestMethod(req.m)) {
      this.sendErr(req.id, 'unknown_method', `unknown method '${req.m}'`);

      return;
    }

    switch (req.m) {
      case 'daemon.ping': {
        this.sendOk(req.id, 'daemon.ping', {});

        return;
      }
      case 'session.list': {
        this.sendOk(req.id, 'session.list', { sessions: ctx.collectSessions() });

        return;
      }
      case 'agents.list': {
        this.sendOk(req.id, 'agents.list', { ...ctx.collectAgents() });

        return;
      }
      case 'dirs.list': {
        this.sendOk(req.id, 'dirs.list', { dirs: await ctx.collectSpawnDirs(null) });

        return;
      }
      case 'fleet.list': {
        const fleet = await ctx.collectFleet();

        this.sendOk(req.id, 'fleet.list', {
          fleet: fleet.filter((entry) => ctx.isSessionVisible(entry.sessionID)),
        });

        return;
      }
      case 'sources.list': {
        await this.applySourcesList(req, ctx);

        return;
      }
      case 'sources.interpret': {
        await this.applySourcesInterpret(req, ctx);

        return;
      }
      case 'git.probe': {
        await this.applyGitProbe(req, ctx);

        return;
      }
      case 'session.spawn': {
        await this.applySpawn(req, ctx);

        return;
      }
      case 'daemon.quit': {
        this.sendOk(req.id, 'daemon.quit', {});
        ctx.quitDaemon();

        return;
      }
      case 'daemon.backup': {
        const parsed = parseRequestParams('daemon.backup', req.p);

        if (!parsed.ok) {
          this.sendErr(req.id, 'bad_args', parsed.message);

          return;
        }

        this.sendOk(req.id, 'daemon.backup', {
          path: parsed.data.path,
          bytes: await ctx.writeStateBackup(parsed.data.path),
        });

        return;
      }
      case 'session.update': {
        const parsed = parseRequestParams('session.update', req.p);

        if (!parsed.ok) {
          this.sendErr(req.id, 'bad_args', parsed.message);

          return;
        }

        const sessionID = parsed.data.session;

        const updated = ctx.updateSession(sessionID, {
          ...(parsed.data.name === undefined ? {} : { name: parsed.data.name }),
          ...(parsed.data.pinned === undefined ? {} : { pinned: parsed.data.pinned }),
          ...(parsed.data.parent === null ? { parent: null } : {}),
        });

        if (updated === 'shared_host') {
          this.sendErr(
            req.id,
            'bad_args',
            `session '${sessionID}' runs in its parent's host and cannot be detached from it or pinned apart from it`,
          );
        } else if (updated === 'agent_named') {
          this.sendOk(req.id, 'session.update', { renameSkipped: 'agent_named' });
        } else if (updated) {
          this.sendOk(req.id, 'session.update', {});
        } else {
          this.sendErr(req.id, 'no_such_session', `no session '${sessionID}'`);
        }

        return;
      }
      case 'session.scope.add': {
        await this.applyScopeAdd(req, ctx);

        return;
      }
      case 'session.kill': {
        await this.applyKill(req, ctx);

        return;
      }
      case 'session.ack': {
        await this.applySessionVerb(req, 'session.ack', ctx.ackSession);

        return;
      }
      case 'session.forget': {
        const parsed = parseRequestParams('session.forget', req.p);

        if (!parsed.ok) {
          this.sendErr(req.id, 'bad_args', parsed.message);

          return;
        }

        const id = parsed.data.session;

        const forgotten = await ctx.forgetSession(
          id,
          parsed.data.confirmToken,
          { pinned: parsed.data.refusePinned === true, live: parsed.data.refuseLive === true },
          this.callerSession,
        );

        if (forgotten === 'missing') {
          this.sendErr(req.id, 'no_such_session', `no session '${id}'`);
        } else {
          this.sendOk(req.id, 'session.forget', { ...forgotten });
        }

        return;
      }
      case 'session.auth.revoke': {
        const parsed = parseRequestParams('session.auth.revoke', req.p);

        if (!parsed.ok) {
          this.sendErr(req.id, 'bad_args', parsed.message);

          return;
        }

        const id = parsed.data.session;

        const revoked = await ctx.revokeSessionAuth(id);

        if (revoked) {
          this.sendOk(req.id, 'session.auth.revoke', { revoked: true });
        } else {
          this.sendErr(req.id, 'no_such_session', `no session '${id}'`);
        }

        return;
      }
      case 'session.auth.rebind': {
        const parsed = parseRequestParams('session.auth.rebind', req.p);

        if (!parsed.ok) {
          this.sendErr(req.id, 'bad_args', parsed.message);

          return;
        }

        const id = parsed.data.session;

        const rebound = await ctx.updateSessionAuth(id);

        if (rebound === null) {
          this.sendErr(req.id, 'no_such_session', `no session '${id}'`);
        } else {
          this.sendOk(req.id, 'session.auth.rebind', { ...rebound });
        }

        return;
      }
      case 'session.resumeCommand': {
        const parsed = parseRequestParams('session.resumeCommand', req.p);

        if (!parsed.ok) {
          this.sendErr(req.id, 'bad_args', parsed.message);

          return;
        }

        const id = parsed.data.session;
        const resume = ctx.buildResumeCommand(id);

        if ('command' in resume) {
          this.sendOk(req.id, 'session.resumeCommand', { command: resume.command });
        } else if (resume.refusal === 'missing') {
          this.sendErr(req.id, 'no_such_session', `no session '${id}'`);
        } else {
          this.sendErr(req.id, 'unsupported', resume.reason);
        }

        return;
      }
      case 'session.screen': {
        const parsed = parseRequestParams('session.screen', req.p);

        if (!parsed.ok) {
          this.sendErr(req.id, 'bad_args', parsed.message);

          return;
        }

        const id = parsed.data.session;

        const screen = await ctx.readSessionScreen(id);

        if (screen === 'missing' || !ctx.isSessionVisible(id)) {
          this.sendErr(req.id, 'no_such_session', `no session '${id}'`);
        } else if (screen === 'no_screen') {
          this.sendErr(req.id, 'session_dead', `session '${id}' has no captured screen`);
        } else {
          this.sendOk(req.id, 'session.screen', { ...screen });
        }

        return;
      }
      case 'session.menu': {
        this.applySessionMenu(req, ctx);

        return;
      }
      case 'session.choose': {
        this.applySessionChoose(req, ctx);

        return;
      }
      case 'session.eject': {
        const parsed = parseRequestParams('session.eject', req.p);

        if (!parsed.ok) {
          this.sendErr(req.id, 'bad_args', parsed.message);

          return;
        }

        const sessionID = parsed.data.session;
        const result = ctx.ejectSession(sessionID, parsed.data.prompt);

        if (result === 'ok') {
          this.sendOk(req.id, 'session.eject', {});
        } else if (result === 'unsupported') {
          this.sendErr(req.id, 'unsupported', "this session's agent has no headless handoff");
        } else if (result === 'no_transcript') {
          this.sendNoTranscript(req.id);
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

        const adoptResult = await ctx.adoptSession(
          sessionID,
          parsed.data.cols,
          parsed.data.rows,
          null,
        );

        if (adoptResult === 'ok') {
          this.sendOk(req.id, 'session.adopt', {});
        } else if (adoptResult === 'no_transcript') {
          this.sendNoTranscript(req.id);
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
        this.applyAttach(req, ctx);

        return;
      }
      case 'session.detach': {
        const parsed = parseRequestParams('session.detach', req.p);

        if (!parsed.ok) {
          this.sendErr(req.id, 'bad_args', parsed.message);

          return;
        }

        ctx.detachSession(this, parsed.data.session);
        this.sendOk(req.id, 'session.detach', {});

        return;
      }
      case 'session.input': {
        this.applyInput(req, ctx);

        return;
      }
      case 'session.submit': {
        await this.applySubmit(req, ctx);

        return;
      }
      case 'session.resize': {
        this.applyResize(req, ctx);

        return;
      }
      case 'permission.respond': {
        this.applyPermissionRespond(req, ctx);

        return;
      }
      case 'session.message': {
        await this.applySessionMessage(req, ctx);

        return;
      }
      case 'session.tap': {
        this.applyTap(req, ctx);

        return;
      }
      case 'message.get': {
        await this.applyMessageGet(req, ctx);

        return;
      }
      case 'message.ack': {
        await this.applyMessageAck(req, ctx);

        return;
      }
      case 'notice.ack': {
        await this.applyNoticeAck(req, ctx);

        return;
      }
      case 'fleet.restore': {
        const parsed = parseRequestParams('fleet.restore', req.p);

        if (!parsed.ok) {
          this.sendErr(req.id, 'bad_args', parsed.message);

          return;
        }

        this.sendOk(req.id, 'fleet.restore', {
          restored: await ctx.restoreFleet(parsed.data.cols, parsed.data.rows),
        });

        return;
      }
      case 'session.get': {
        await this.applySessionGet(req, ctx);

        return;
      }
      case 'session.read': {
        await this.applySessionRead(req, ctx);

        return;
      }
      case 'events.read': {
        await this.applyEventsRead(req, ctx);

        return;
      }
      case 'note.get': {
        await this.applyNoteGet(req, ctx);

        return;
      }
      case 'answer.get': {
        await this.applyAnswerGet(req, ctx);

        return;
      }

      // The handshake is answered before a request is admitted, so it never
      // runs as one.
      case 'daemon.hello': {
        this.sendErr(req.id, 'unknown_method', `unknown method '${req.m}'`);
      }
    }
  }

  // A client inside a session never adds to the record of that session or
  // of a session it is a sub-session of: only a caller outside the tree
  // vouches for what the session may touch.
  private async applyScopeAdd(req: RequestMsg, ctx: DaemonContext): Promise<void> {
    const parsed = parseRequestParams('session.scope.add', req.p);

    if (!parsed.ok) {
      this.sendErr(req.id, 'bad_args', parsed.message);

      return;
    }

    const sessionID = parsed.data.session;
    const declared = parseDeclaredScope(parsed.data.scope);

    if (!declared.ok) {
      this.sendErr(req.id, 'scope_invalid', declared.message, { entry: declared.entry });

      return;
    }

    if (this.callerSession !== null && ctx.isCallerTree(sessionID, this.callerSession)) {
      this.sendErr(
        req.id,
        'unauthorized',
        `session '${this.callerSession}' cannot add to the scope of session '${sessionID}': a session never widens its own scope or that of a session above it`,
      );

      return;
    }

    const record = await ctx.updateSessionScope(sessionID, declared.scope);

    if (record === 'missing') {
      this.sendErr(req.id, 'no_such_session', `no session '${sessionID}'`);

      return;
    }

    this.sendOk(req.id, 'session.scope.add', { record });
  }

  private async applySpawn(req: RequestMsg, ctx: DaemonContext): Promise<void> {
    const parsed = parseRequestParams('session.spawn', req.p);

    if (!parsed.ok) {
      this.sendErr(req.id, 'bad_args', parsed.message);

      return;
    }

    const data = parsed.data;
    const cwd = data.cwd;

    if (cwd === undefined && data.workspace?.kind !== 'git') {
      this.sendErr(req.id, 'bad_args', 'session.spawn requires a cwd');

      return;
    }

    // Every refusal is thrown from the plan, which runs only once a key is
    // claimed: a retry of a held key answers from the key without checking
    // anything again, and a refused spawn drops its claim.
    const plan = (): SpawnParams => {
      // The target goes first: a config or target problem is the cause a
      // spawn reports, ahead of any agent check that problem can skew.
      const target = ctx.resolveSpawnTarget(data.target);
      const agent: AgentID = data.agent ?? ctx.collectAgents().spawnDefaults.agent;
      const adapter = ctx.findAdapter(agent);
      const entry = ctx.collectAgents().agents.find((candidate) => candidate.id === agent);

      if (adapter === null || entry === undefined) {
        throw new DaemonError('unsupported', `no adapter for agent '${agent}'`);
      }

      // A stand-in adapter declares no binary to check, so only a profiled
      // agent's missing binary refuses the spawn.
      if (adapter.profile !== undefined && !entry.installed) {
        throw new DaemonError(
          'unsupported',
          `agent '${agent}' is registered but not installed on this host`,
        );
      }

      // Checked before any workspace is materialized for the spawn.
      const refusal = adapter.findSpawnRefusal?.() ?? null;

      if (refusal !== null) {
        throw refusal;
      }

      ctx.requireAgentTarget(agent, target);

      const overrides = parseSpawnOverrides(entry, { model: data.model, effort: data.effort });

      if (!overrides.ok) {
        throw new DaemonError(overrides.code, overrides.message);
      }

      // Checked before the spawn starts, so a target that cannot take a
      // workspace refuses it before any git command runs.
      if (data.workspace !== undefined) {
        ctx.requireWorkspaceTarget(target);
      }

      // A git workspace without a cwd lands where the daemon picks on the
      // target.
      const dir =
        cwd === undefined && data.workspace?.kind === 'git'
          ? ctx.buildDefaultWorkspaceDir(target, data.workspace)
          : cwd;

      if (dir === undefined) {
        throw new DaemonError('bad_args', 'session.spawn requires a cwd');
      }

      // A workspace is materialized at cwd on the target, which only an
      // absolute path names; a directory the daemon picks on a remote
      // target is relative to the home there, which the host resolves.
      if (data.workspace !== undefined && cwd !== undefined && !isAbsolute(cwd)) {
        throw new DaemonError('bad_args', 'a spawn with a workspace requires an absolute cwd');
      }

      // A workspace is created, filled, and removed at the one directory
      // the host resolves cwd to, which a dot segment or a control
      // character would make differ from the path as written.
      if (data.workspace !== undefined && !isPlainWorkspaceDir(dir)) {
        throw new DaemonError(
          'bad_args',
          'a spawn with a workspace requires a cwd without . or .. segments or control characters',
        );
      }

      let parent: SessionID | null = null;

      if (data.parent !== undefined) {
        const resolved = ctx.resolveSpawnParent(data.parent);

        if (resolved === 'missing') {
          throw new DaemonError('no_such_session', `no session '${data.parent}'`);
        }

        parent = resolved;
      }

      return {
        cwd: dir,
        name: data.name === '' ? basename(dir) : data.name,
        prompt: data.prompt,
        cols: data.cols,
        rows: data.rows,
        resume: data.resume,
        namedBy: data.name === '' ? 'auto' : 'user',
        agent,
        parent,
        overrides: {
          ...overrides.overrides,
          ...(data.trustClonedWorkspace === undefined
            ? {}
            : { trustClonedWorkspace: data.trustClonedWorkspace }),
        },
        target,
        workspace: data.workspace ?? null,
        autoDir: cwd === undefined,
        scope: requireDeclaredScope(data.scope),
      };
    };

    if (data.replayOnly === true && data.idempotencyKey === undefined) {
      this.sendErr(req.id, 'bad_args', 'replayOnly needs an idempotencyKey');

      return;
    }

    const keyed = buildKeyedRequest(data);

    const spawned = await ctx.spawnSession(plan, keyed, null);

    const sessionID = toSessionID(spawned.session.id);
    const grant = ctx.findSessionGrant(sessionID);

    // A live session whose tree left the view before the answer goes out gets the refusal a
    // replay out of reach gets; a replayed session no longer live was checked against its
    // fleet row by the replay itself.
    if (grant !== null && !ctx.isSessionVisible(sessionID)) {
      throw buildTargetForbiddenError(grant.target);
    }

    this.sendOk(req.id, 'session.spawn', spawned);
  }

  // Lists one source's candidates for a spawn to the request's target.
  private async applySourcesList(req: RequestMsg, ctx: DaemonContext): Promise<void> {
    const parsed = parseRequestParams('sources.list', req.p);

    if (!parsed.ok) {
      this.sendErr(req.id, 'bad_args', parsed.message);

      return;
    }

    const resolved = this.resolveSourceRequest(parsed.data, ctx);
    const source = resolved.source;

    const listed = await source.list(
      {
        ...(parsed.data.scope === undefined ? {} : { scope: parsed.data.scope }),
        ...(parsed.data.text === undefined ? {} : { text: parsed.data.text }),
      },
      resolved.request,
    );

    this.sendOk(req.id, 'sources.list', {
      source: source.id,
      scope: listed.scope,
      candidates: listed.candidates,
    });
  }

  // Reads typed input through one source for a spawn to the request's
  // target.
  private async applySourcesInterpret(req: RequestMsg, ctx: DaemonContext): Promise<void> {
    const parsed = parseRequestParams('sources.interpret', req.p);

    if (!parsed.ok) {
      this.sendErr(req.id, 'bad_args', parsed.message);

      return;
    }

    const resolved = this.resolveSourceRequest(parsed.data, ctx);

    const interpretation = await resolved.source.interpret(parsed.data.input, resolved.request);

    this.sendOk(req.id, 'sources.interpret', { ...interpretation });
  }

  // The source a request asks for and the request it serves, so a principal
  // reaches a source only for a target it may spawn on, and a git source
  // only for a target it may spawn a workspace on.
  private resolveSourceRequest(params: SourceParams, ctx: DaemonContext): ResolvedSourceRequest {
    const source = ctx.findSource(params.source);

    if (source === null) {
      throw new DaemonError('unsupported', `this daemon offers no source '${params.source}'`);
    }

    const target = ctx.resolveSpawnTarget(params.target);

    if (source.kind === 'git') {
      this.ctx.requireWorkspaceTarget(target);
    }

    // The spawn history is read through the request's own view, so a
    // principal lists only directories spawned on targets it may use.
    return { source, request: { target, collectSpawnDirs: () => ctx.collectSpawnDirs(null) } };
  }

  // Probes a git workspace source for a spawn to the request's target, so
  // a principal probes only for a target it may spawn a workspace on. A
  // refusal holds the repository's other URLs that the offered sources know.
  private async applyGitProbe(req: RequestMsg, ctx: DaemonContext): Promise<void> {
    const parsed = parseRequestParams('git.probe', req.p);

    if (!parsed.ok) {
      this.sendErr(req.id, 'bad_args', parsed.message);

      return;
    }

    const data = parsed.data;

    this.ctx.requireWorkspaceTarget(ctx.resolveSpawnTarget(data.target));

    const access = await ctx.checkRepositoryAccess({
      url: data.url,
      ref: data.ref,
      sha: data.sha,
      credential: data.credentialRef,
    });

    if (!access.ok) {
      const alternates = ctx.collectAlternateGitURLs(data.url);
      const detail = alternates.length === 0 ? undefined : { alternates };

      throw new DaemonError(access.code, access.message, detail);
    }

    this.sendOk(req.id, 'git.probe', {
      url: access.url,
      head: access.head,
      refs: access.refs,
      resolved: access.resolved,
    });
  }

  private applyAttach(req: RequestMsg, ctx: DaemonContext): void {
    const parsed = parseRequestParams('session.attach', req.p);

    if (!parsed.ok) {
      this.sendErr(req.id, 'bad_args', parsed.message);

      return;
    }

    const sessionID = parsed.data.session;

    const result = ctx.attachSession(this, sessionID, {
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

    const dims = ctx.getEffectiveDims(sessionID);

    this.sendOk(req.id, 'session.attach', { cols: dims.cols, rows: dims.rows });
  }

  private applyInput(req: RequestMsg, ctx: DaemonContext): void {
    const parsed = parseRequestParams('session.input', req.p);

    if (!parsed.ok) {
      this.sendErr(req.id, 'bad_args', parsed.message);

      return;
    }

    const sessionID = parsed.data.session;

    this.sendInputResult(
      req,
      'session.input',
      sessionID,
      ctx.writeSessionInput(sessionID, parsed.data.d),
    );
  }

  private async applySubmit(req: RequestMsg, ctx: DaemonContext): Promise<void> {
    const parsed = parseRequestParams('session.submit', req.p);

    if (!parsed.ok) {
      this.sendErr(req.id, 'bad_args', parsed.message);

      return;
    }

    const sessionID = parsed.data.session;

    const result = await ctx.writeSessionLine(sessionID, parsed.data.text);

    this.sendInputResult(req, 'session.submit', sessionID, result);
  }

  private applySessionMenu(req: RequestMsg, ctx: DaemonContext): void {
    const parsed = parseRequestParams('session.menu', req.p);

    if (!parsed.ok) {
      this.sendErr(req.id, 'bad_args', parsed.message);

      return;
    }

    const id = parsed.data.session;

    if (!ctx.isSessionVisible(id)) {
      this.sendErr(req.id, 'no_such_session', `no session '${id}'`);

      return;
    }

    // A read rejects with a DaemonError when the menu changes or ignores a key. The session
    // can leave the caller's view while the read runs, so its view is checked again before
    // the menu goes out.
    this.answerAsync(req.id, async () => {
      const menu = await ctx.readSessionMenu(id);

      if (menu === 'missing' || !ctx.isSessionVisible(id)) {
        this.sendErr(req.id, 'no_such_session', `no session '${id}'`);
      } else if (menu === 'no_screen') {
        this.sendErr(req.id, 'session_dead', `session '${id}' has no captured screen`);
      } else if (menu === 'unsupported') {
        this.sendErr(req.id, 'unsupported', `atc cannot read the menus in session '${id}'`);
      } else {
        this.sendOk(req.id, 'session.menu', { menu });
      }
    });
  }

  // A choice whose menu, label, or cursor does not match the screen rejects
  // with its DaemonError, which answers with that error's code.
  private applySessionChoose(req: RequestMsg, ctx: DaemonContext): void {
    const parsed = parseRequestParams('session.choose', req.p);

    if (!parsed.ok) {
      this.sendErr(req.id, 'bad_args', parsed.message);

      return;
    }

    const id = parsed.data.session;
    const menuToken = parsed.data.menuToken;

    if (!ctx.isSessionVisible(id)) {
      this.sendErr(req.id, 'no_such_session', `no session '${id}'`);

      return;
    }

    const choice =
      parsed.data.key === 'escape'
        ? { menuToken, key: parsed.data.key }
        : { menuToken, option: parsed.data.option ?? 0, label: parsed.data.label ?? '' };

    this.answerAsync(req.id, async () => {
      const result = await ctx.applySessionMenuChoice(id, choice);

      if (result === 'missing') {
        this.sendErr(req.id, 'no_such_session', `no session '${id}'`);
      } else if (result === 'dead') {
        this.sendErr(req.id, 'session_dead', `session '${id}' has no live process`);
      } else if (result === 'unsupported') {
        this.sendErr(req.id, 'unsupported', `atc cannot read the menus in session '${id}'`);
      } else {
        this.sendOk(req.id, 'session.choose', { ...result });
      }
    });
  }

  private sendInputResult(
    req: RequestMsg,
    method: 'session.input' | 'session.submit',
    sessionID: SessionID,
    result: 'busy' | 'ok' | 'missing' | 'dead' | 'permission_pending',
  ): void {
    if (result === 'permission_pending') {
      this.sendErr(
        req.id,
        'permission_pending',
        `session '${sessionID}' is waiting on a permission prompt, where typed text picks the highlighted option; answer the prompt's menu with session.choose or in the atc TUI`,
      );

      return;
    }

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

    this.sendOk(req.id, method, {});
  }

  private applyResize(req: RequestMsg, ctx: DaemonContext): void {
    const parsed = parseRequestParams('session.resize', req.p);

    if (!parsed.ok) {
      this.sendErr(req.id, 'bad_args', parsed.message);

      return;
    }

    const sessionID = parsed.data.session;

    if (!ctx.resizeSession(this, sessionID, { cols: parsed.data.cols, rows: parsed.data.rows })) {
      this.sendErr(req.id, 'bad_args', `not attached to session '${sessionID}'`);

      return;
    }

    this.sendOk(req.id, 'session.resize', {});
  }

  private applyPermissionRespond(req: RequestMsg, ctx: DaemonContext): void {
    const parsed = parseRequestParams('permission.respond', req.p);

    if (!parsed.ok) {
      this.sendErr(req.id, 'bad_args', parsed.message);

      return;
    }

    const request = parsed.data.request;
    const decision = parsed.data.decision;
    const result = ctx.answerPermission(request, decision);

    match(result)
      .with('ok', () => {
        this.sendOk(req.id, 'permission.respond', {});
      })
      .with('already_answered', () => {
        this.sendErr(req.id, 'already_answered', `request '${request}' was already answered`);
      })
      .with('unsupported', () => {
        this.sendErr(req.id, 'unsupported', `request '${request}' is answered with keystrokes`);
      })
      .with('unknown', () => {
        this.sendErr(req.id, 'bad_args', `unknown permission request '${request}'`);
      })
      .exhaustive();
  }

  private async applySessionGet(req: RequestMsg, ctx: DaemonContext): Promise<void> {
    const parsed = parseRequestParams('session.get', req.p);

    if (!parsed.ok) {
      this.sendErr(req.id, 'bad_args', parsed.message);

      return;
    }

    const id = parsed.data.session;

    const record = await ctx.readSessionRecord(id, null);

    if (record === 'missing' || !ctx.isSessionVisible(id)) {
      this.sendErr(req.id, 'no_such_session', `no session '${id}'`);

      return;
    }

    this.sendOk(req.id, 'session.get', { ...record });
  }

  private async applySessionRead(req: RequestMsg, ctx: DaemonContext): Promise<void> {
    const parsed = parseRequestParams('session.read', req.p);

    if (!parsed.ok) {
      this.sendErr(req.id, 'bad_args', parsed.message);

      return;
    }

    const id = parsed.data.session;
    let from: TranscriptPosition | null = null;

    if (parsed.data.cursor !== undefined) {
      const decoded = decodeCursor(parsed.data.cursor);

      if (decoded === null || decoded.kind !== 'transcript') {
        this.sendErr(req.id, 'bad_args', `'${parsed.data.cursor}' is not a session.read cursor`);

        return;
      }

      from = { path: decoded.path, offset: decoded.offset };
    }

    const read = await ctx.loadSessionTranscript(id, from, parsed.data.limit);

    if (read === 'missing' || !ctx.isSessionVisible(id)) {
      this.sendErr(req.id, 'no_such_session', `no session '${id}'`);
    } else if (read === 'unsupported') {
      this.sendErr(
        req.id,
        'unsupported',
        `session '${id}' runs an agent whose transcript atc cannot read`,
      );
    } else {
      this.sendOk(req.id, 'session.read', {
        rows: read.page.rows,
        cursor: encodeCursor({ kind: 'transcript', path: read.path, offset: read.page.offset }),
        more: read.page.more,
      });
    }
  }

  private async applyEventsRead(req: RequestMsg, ctx: DaemonContext): Promise<void> {
    const parsed = parseRequestParams('events.read', req.p);

    if (!parsed.ok) {
      this.sendErr(req.id, 'bad_args', parsed.message);

      return;
    }

    let afterID: number | null = null;

    if (parsed.data.cursor !== undefined) {
      const decoded = decodeCursor(parsed.data.cursor);

      if (decoded === null || decoded.kind !== 'events') {
        this.sendErr(req.id, 'bad_args', `'${parsed.data.cursor}' is not an events.read cursor`);

        return;
      }

      afterID = decoded.id;
    }

    const page = await ctx.readEvents(
      afterID,
      parsed.data.limit,
      parsed.data.waitMs,
      parsed.data.session ?? null,
      null,
    );

    // An event of a session that left the view while the read waited is
    // left out, as the read leaves out every event out of reach.
    const events = page.events.filter((event) => ctx.isSessionVisible(toSessionID(event.session)));
    const last = events.at(-1);

    // A cursor always comes back so a client can long-poll from an empty trail.
    this.sendOk(req.id, 'events.read', {
      events,
      cursor: last === undefined ? encodeCursor({ kind: 'events', id: afterID ?? 0 }) : last.cursor,
      more: page.more,
    });
  }

  // A cursor that is not an events cursor, one at a row that holds no
  // note, and one at a note outside the access all get one refusal, so
  // the refusal is the same for a note out of reach and a missing one.
  private async applyNoteGet(req: RequestMsg, ctx: DaemonContext): Promise<void> {
    const parsed = parseRequestParams('note.get', req.p);

    if (!parsed.ok) {
      this.sendErr(req.id, 'bad_args', parsed.message);

      return;
    }

    const decoded = decodeCursor(parsed.data.note);

    const read =
      decoded === null || decoded.kind !== 'events' ? null : await ctx.readNote(decoded.id, null);

    // Reach is checked against the session that sent the note, never the
    // session its view is named by.
    if (read === null || !ctx.isSessionVisible(read.owner)) {
      this.sendErr(req.id, 'bad_args', `no note '${parsed.data.note}'`);

      return;
    }

    this.sendOk(req.id, 'note.get', { ...read.view });
  }

  // A cursor that is not an events cursor, one at a row that holds no
  // answer, and one at an answer outside the access all get one refusal,
  // as a note read does.
  private async applyAnswerGet(req: RequestMsg, ctx: DaemonContext): Promise<void> {
    const parsed = parseRequestParams('answer.get', req.p);

    if (!parsed.ok) {
      this.sendErr(req.id, 'bad_args', parsed.message);

      return;
    }

    const decoded = decodeCursor(parsed.data.answer);

    const read =
      decoded === null || decoded.kind !== 'events' ? null : await ctx.readAnswer(decoded.id, null);

    if (read === null || !ctx.isSessionVisible(read.owner)) {
      this.sendErr(req.id, 'bad_args', `no answer '${parsed.data.answer}'`);

      return;
    }

    this.sendOk(req.id, 'answer.get', { ...read.view });
  }

  private async applySessionMessage(req: RequestMsg, ctx: DaemonContext): Promise<void> {
    const parsed = parseRequestParams('session.message', req.p);

    if (!parsed.ok) {
      this.sendErr(req.id, 'bad_args', parsed.message);

      return;
    }

    const sessionID = parsed.data.session;

    if (parsed.data.replayOnly === true && parsed.data.idempotencyKey === undefined) {
      this.sendErr(req.id, 'bad_args', 'replayOnly needs an idempotencyKey');

      return;
    }

    // The hash leaves out a local caller's name, as a daemon that ignored it
    // stored it, so a retry across an upgrade replays.
    const { from: localName, ...hashed } = parsed.data;
    const keyed = buildKeyedRequest(hashed);

    // An older client's default sender names, so a key an older daemon
    // stored with one still replays.
    const legacyNames = ['mcp', req.asName, this.callerSession];

    const legacyKeyed =
      keyed === null
        ? null
        : {
            ...keyed,
            legacyPayloadHashes: buildLegacyMessageHashes(hashed, req.p?.['from'], legacyNames),
          };

    // A send that needs no answer leaves no session to notify.
    const noticeSession = parsed.data.notice === false ? null : this.callerSession;

    const result = await ctx.writeSessionMessage(
      sessionID,
      this.findMessageCaller(req, localName),
      parsed.data.text,
      legacyKeyed,
      null,
      noticeSession,
    );

    if (result === 'missing' || !ctx.isSessionVisible(sessionID)) {
      this.sendErr(req.id, 'no_such_session', `no session '${sessionID}'`);

      return;
    }

    if (result === 'dead') {
      this.sendErr(req.id, 'session_dead', `session '${sessionID}' has no live process`);

      return;
    }

    if (result === 'unsupported') {
      this.sendErr(
        req.id,
        'unsupported',
        `session '${sessionID}' cannot take messages: its agent has no message tap`,
      );

      return;
    }

    if (result === 'no_tap') {
      this.sendErr(req.id, 'unsupported', `session '${sessionID}' never attached a message tap`);

      return;
    }

    this.sendOk(req.id, 'session.message', result);
  }

  // The kernel's session wins over any principal a request gives. A local name is the only
  // part of the request's params that labels the message, and never changes the kind.
  private findMessageCaller(req: RequestMsg, localName: string | undefined): MessageCaller {
    if (this.peerSession !== null) {
      return { kind: 'session', session: this.peerSession };
    }

    if (req.as !== undefined) {
      return { kind: 'connector', client: req.as, name: req.asName ?? req.as };
    }

    if (this.principal !== null) {
      return { kind: 'connector', client: this.principal, name: this.principal };
    }

    if (this.callerSession !== null) {
      return { kind: 'session', session: this.callerSession };
    }

    if (isAtcClient(this.helloClient)) {
      return { kind: 'owner' };
    }

    return { kind: 'local', name: localName ?? this.helloClient };
  }

  private applyTap(req: RequestMsg, ctx: DaemonContext): void {
    const parsed = parseRequestParams('session.tap', req.p);

    if (!parsed.ok) {
      this.sendErr(req.id, 'bad_args', parsed.message);

      return;
    }

    const sessionID = parsed.data.session;
    const result = ctx.attachTap(this, sessionID, null, parsed.data.notices);

    if (result === 'missing') {
      this.sendErr(req.id, 'no_such_session', `no session '${sessionID}'`);

      return;
    }

    if (result === 'unsupported') {
      this.sendErr(req.id, 'unsupported', `session '${sessionID}' cannot take messages`);

      return;
    }

    this.sendOk(req.id, 'session.tap', {});
  }

  private async applyMessageGet(req: RequestMsg, ctx: DaemonContext): Promise<void> {
    const parsed = parseRequestParams('message.get', req.p);

    if (!parsed.ok) {
      this.sendErr(req.id, 'bad_args', parsed.message);

      return;
    }

    const messageID = parsed.data.message;

    const view = await ctx.readMessage(messageID, parsed.data.waitMs);

    if (view === null || !ctx.isSessionVisible(view.session)) {
      this.sendErr(req.id, 'bad_args', `no message '${messageID}'`);

      return;
    }

    const record = view.record;

    // A message the turn also answered is listed only while the session it
    // was sent to is in view, checked in the step that sends.
    const answeredWith = view.answeredWith
      .filter((sibling) => ctx.isSessionVisible(sibling.atcID))
      .map((sibling) => sibling.id);

    this.sendOk(req.id, 'message.get', {
      message: record.id,
      session: view.session,
      from: record.from,
      ...(record.sender === undefined ? {} : { sender: record.sender }),
      text: record.text,
      status: record.status,
      sentAt: record.sentAt,
      ...(record.deliveredAt === undefined ? {} : { deliveredAt: record.deliveredAt }),
      ...(record.answeredAt === undefined ? {} : { answeredAt: record.answeredAt }),
      ...(record.answer === undefined ? {} : { answer: record.answer }),
      ...(record.unansweredAt === undefined ? {} : { unansweredAt: record.unansweredAt }),
      ...(record.unansweredReason === undefined
        ? {}
        : { unansweredReason: record.unansweredReason }),
      turn: record.turn ?? null,
      answeredWith,
    });
  }

  private async applyMessageAck(req: RequestMsg, ctx: DaemonContext): Promise<void> {
    const parsed = parseRequestParams('message.ack', req.p);

    if (!parsed.ok) {
      this.sendErr(req.id, 'bad_args', parsed.message);

      return;
    }

    const sessionID = parsed.data.session;
    const messageID = parsed.data.message;

    const result = await ctx.ackMessage(this, sessionID, messageID, null);

    if (result === 'not_tapping') {
      this.sendErr(req.id, 'bad_args', `this connection is not tapping session '${sessionID}'`);

      return;
    }

    if (result === 'unknown' || !ctx.isSessionVisible(sessionID)) {
      this.sendErr(req.id, 'bad_args', `no message '${messageID}' for session '${sessionID}'`);

      return;
    }

    this.sendOk(req.id, 'message.ack', { message: result.id, status: result.status });
  }

  private async applyNoticeAck(req: RequestMsg, ctx: DaemonContext): Promise<void> {
    const parsed = parseRequestParams('notice.ack', req.p);

    if (!parsed.ok) {
      this.sendErr(req.id, 'bad_args', parsed.message);

      return;
    }

    const sessionID = parsed.data.session;
    const messageID = parsed.data.message;

    const result = await ctx.ackNotice(this, sessionID, messageID);

    if (result === 'not_tapping') {
      this.sendErr(req.id, 'bad_args', `this connection is not tapping session '${sessionID}'`);

      return;
    }

    if (result === 'unknown' || !ctx.isSessionVisible(sessionID)) {
      this.sendErr(
        req.id,
        'bad_args',
        `no answer notice of message '${messageID}' for session '${sessionID}'`,
      );

      return;
    }

    this.sendOk(req.id, 'notice.ack', { message: result.id, status: result.status });
  }

  private async applyKill(req: RequestMsg, ctx: DaemonContext): Promise<void> {
    const parsed = parseRequestParams('session.kill', req.p);

    if (!parsed.ok) {
      this.sendErr(req.id, 'bad_args', parsed.message);

      return;
    }

    const stopOnly = parsed.data.stopOnly === true;

    const outcome = await ctx.killSession(parsed.data.session, stopOnly);

    if (outcome === 'missing') {
      this.sendErr(req.id, 'no_such_session', `no session '${parsed.data.session}'`);

      return;
    }

    const answer = stopOnly ? { stopped: outcome === 'stopped' } : {};

    this.sendOk(req.id, 'session.kill', answer);
  }

  private async applySessionVerb(
    req: RequestMsg,
    method: 'session.ack',
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
      this.sendOk(req.id, method, {});
    } else {
      this.sendErr(req.id, 'no_such_session', `no session '${id}'`);
    }
  }

  private applyHello(req: RequestMsg): boolean {
    const parsedHello = parseRequestParams('daemon.hello', req.p);
    const client = parsedHello.ok ? parsedHello.data.client : 'unknown client';

    this.helloClient = client;

    // A principal the handshake cannot read would otherwise leave the
    // connection with the owner's reach.
    if (!parsedHello.ok && req.p?.['principal'] !== undefined) {
      this.sendErr(req.id, 'bad_args', parsedHello.message);

      return false;
    }

    const principal = parsedHello.ok ? (parsedHello.data.principal ?? null) : null;

    if (principal !== null) {
      this.setPrincipal(principal);
    }

    const declared = parsedHello.ok ? (parsedHello.data.session ?? null) : null;

    // The kernel's answer wins over the handshake: a process inside a
    // session acts as that session whether or not it gives one, and one
    // that gives another session is refused.
    if (this.peerSession !== null && declared !== null && declared !== this.peerSession) {
      this.sendErr(
        req.id,
        'unauthorized',
        `daemon.hello gives session '${declared}', but the connecting process runs inside session '${this.peerSession}'`,
      );

      return false;
    }

    this.callerSession = this.peerSession ?? declared;

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

  // Requests that arrive while the check runs wait behind it.
  private applyTCPHello(req: RequestMsg, tcp: TCPPeer): boolean {
    this.helloed = true;

    this.helloAnswered = (async () => {
      const hello = await checkTCPHello(req, {
        tcp,
        hasListedPrincipal: (principal) => this.ctx.hasListedPrincipal(principal),
        build: this.ctx.build,
      });

      if (!hello.ok) {
        this.sendErr(req.id, hello.code, hello.message);
        this.peer.end();

        return;
      }

      if (hello.principal !== null) {
        this.setPrincipal(hello.principal);
      }

      this.callerSession = hello.session;
      this.helloClient = hello.client;
      this.fingerprint = hello.fingerprint;

      await this.sendHelloOk(req.id);
    })();

    this.answerAsync(req.id, () => this.helloAnswered);

    return true;
  }

  // Makes the connection act as the principal, its view starting as the
  // sessions the principal may see now, so one that leaves its reach later
  // is pushed as removed.
  private setPrincipal(principal: string): void {
    const access = this.ctx.buildTargetAccess(principal);

    this.principal = principal;
    this.access = access;

    this.view.startView(access);
  }

  private async sendHelloOk(id: number): Promise<void> {
    this.sendOk(id, 'daemon.hello', {
      daemon: this.ctx.build,
      daemonID: this.ctx.daemonID,
      limits: { maxLine: MAX_LINE, maxChunk: MAX_CHUNK },
      features: DAEMON_FEATURES,
      idempotency: { completedRetentionMs: this.ctx.idempotencyRetentionMs },
      lastUsedAgent: await this.ctx.loadLastUsedAgent(),
    });
  }

  // An answer the full queue refuses ends the connection, as an event does,
  // so the client sees its request fail rather than wait for an answer
  // that never comes.
  private sendOk<M extends RequestMethod>(id: number, _method: M, ok: DaemonAnswer<M>): void {
    if (!this.queue.send(encodeMessage({ v: PROTOCOL_V, id, ok }))) {
      this.peer.end();
    }
  }

  // A resume or adopt of a session whose agent saved no transcript yet.
  private sendNoTranscript(id: number): void {
    this.sendErr(id, 'session_dead', 'nothing to resume yet — the session has no saved transcript');
  }

  private sendErr(
    id: number,
    code: ErrorCode,
    msg: string,
    data?: Readonly<Record<string, unknown>>,
  ): void {
    const queued = this.queue.send(
      encodeMessage({
        v: PROTOCOL_V,
        id,
        err: { code, msg, ...(data === undefined ? {} : { data }) },
      }),
    );

    if (!queued) {
      this.peer.end();
    }
  }
}

function isRequestMethod(method: string): method is RequestMethod {
  return Object.hasOwn(REQUEST_PARAM_SCHEMAS, method);
}

// The token of a handshake's `auth: { scheme: "bearer", token }`, or null
// when its params hold none.

// The session an event belongs to, from its session id or the session it
// adds, or null for an event of no session.

function isPlainWorkspaceDir(dir: string): boolean {
  return (
    !CONTROL_CHARACTER.test(dir) && !dir.split('/').some((part) => part === '.' || part === '..')
  );
}

// A spawn without a scope declares none; one whose scope does not read
// refuses before anything starts, with the entry at fault.
function requireDeclaredScope(raw: unknown): DeclaredScope | null {
  if (raw === undefined) {
    return null;
  }

  const parsed = parseDeclaredScope(raw);

  if (!parsed.ok) {
    throw new DaemonError('scope_invalid', parsed.message, { entry: parsed.entry });
  }

  return parsed.scope;
}

// The client name every atc client gives in its handshake: the atc build,
// `atc/` and its version.
const ATC_CLIENT_PREFIX = 'atc/';

function isAtcClient(client: string): boolean {
  return client.startsWith(ATC_CLIENT_PREFIX);
}

function buildKeyedRequest(
  params: Readonly<Record<string, unknown>> & {
    readonly idempotencyKey?: string | undefined;
    readonly replayOnly?: boolean | undefined;
  },
): KeyedRequest | null {
  return params.idempotencyKey === undefined
    ? null
    : {
        key: params.idempotencyKey,
        payloadHash: buildPayloadHash(params),
        replayOnly: params.replayOnly === true,
      };
}
