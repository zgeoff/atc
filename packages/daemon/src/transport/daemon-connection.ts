import type { SessionID } from '@atc/core';
import { DAEMON_FEATURES, parseRequestParams } from '@atc/protocol';
import type { DaemonAnswer } from '@atc/protocol';
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
import type { EventMsg, RequestMsg, SocketWriter } from '@atc/protocol/wire';
import { buildScopedContext } from '../auth/build-scoped-context';
import { isOwnerOnlyMethod } from '../auth/is-owner-only-method';
import { TargetAccess } from '../auth/target-access';
import type { DaemonContext } from '../daemon-context';
import { buildConnectionRequests } from './build-connection-requests';
import type { ConnectionRequests } from './build-connection-requests';
import { checkTCPHello } from './check-tcp-hello';
import { ConnectionReply } from './connection-reply';
import { ConnectionView } from './connection-view';
import type { ConnectionIdentity } from './request-deps';
import { runDaemonProcedure } from './run-daemon-procedure';
import type { TCPPeer } from './tcp-peer';

// The targets a request may use and the namespace of its idempotency keys.
interface RequestScope {
  readonly access: TargetAccess;
  readonly keyNamespace: string;
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

  // Who the connection acts as, from its handshake and the kernel.
  private readonly identity: ConnectionIdentity;

  // The targets the connection's principal may use; null for the daemon's
  // owner, whose reach has no limit.
  private access: TargetAccess | null = null;

  // What this connection sees of the fleet while its access is limited.
  private readonly view: ConnectionView;

  private readonly reply: ConnectionReply;

  private readonly requests: ConnectionRequests;

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

    this.identity = {
      principal: null,
      callerSession: null,
      peerSession,
      helloClient: 'unknown client',
    };

    this.view = new ConnectionView(ctx);
    this.queue = new OutboundQueue(peer, ctx.queueBytes);
    this.reply = new ConnectionReply(this.queue, peer);

    this.requests = buildConnectionRequests({ client: this, ctx, identity: this.identity });

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
      this.reply.sendErr(0, 'bad_args', `line exceeds ${MAX_LINE} bytes`);
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
      this.reply.sendErr(0, 'bad_args', `malformed line: ${decoded.reason}`);

      return false;
    }

    if (decoded.kind !== 'request') {
      this.reply.sendErr(0, 'bad_args', 'only requests flow client to daemon');

      return false;
    }

    const req = decoded.msg;

    if (req.m === 'daemon.hello') {
      return this.tcp === null ? this.applyHello(req) : this.applyTCPHello(req, this.tcp);
    }

    if (!this.helloed) {
      this.reply.sendErr(req.id, 'unauthorized', 'daemon.hello must be the first request');

      return false;
    }

    if (this.tcp !== null) {
      this.reply.answerAsync(req.id, () => this.applyTCPRequest(req));

      return true;
    }

    const scope = this.findRequestScope(req);

    if (scope !== null && isOwnerOnlyMethod(req.m)) {
      this.reply.sendErr(req.id, 'unauthorized', `${req.m} is open to the daemon's owner only`);

      return true;
    }

    const ctx =
      scope === null ? this.ctx : buildScopedContext(this.ctx, scope.access, scope.keyNamespace);

    this.reply.answerAsync(req.id, () => this.applyRequest(req, ctx));

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
      this.reply.sendErr(decoded.msg.id, 'unauthorized', 'a TCP connection takes one handshake');

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
      this.reply.sendErr(req.id, 'unauthorized', `${req.m} is open to the daemon's owner only`);

      return;
    }

    if (req.as === undefined) {
      this.reply.sendErr(
        req.id,
        'unauthorized',
        'a request over TCP must act as a principal with as',
      );

      return;
    }

    if (!this.ctx.hasListedPrincipal(req.as)) {
      this.tcp?.recordRefusedPrincipal();

      this.reply.sendErr(
        req.id,
        'unauthorized',
        `principal '${req.as}' is not listed in principals`,
      );

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
      return this.identity.principal === null || this.access === null
        ? null
        : { access: this.access, keyNamespace: `client:${this.identity.principal}` };
    }

    const access = this.ctx.buildTargetAccess(req.as);

    if (this.identity.principal === null || this.access === null) {
      return { access, keyNamespace: `client:${req.as}` };
    }

    return { access: this.access.merge(access), keyNamespace: `client:${this.identity.principal}` };
  }

  private async applyRequest(req: RequestMsg, ctx: DaemonContext): Promise<void> {
    await this.helloAnswered;

    const answer = await runDaemonProcedure(req.m, req.p, {
      ctx,
      requests: this.requests,
      as: req.as === undefined ? null : { principal: req.as, name: req.asName },
    });

    this.reply.sendAnswer(req.id, answer);
  }

  private applyHello(req: RequestMsg): boolean {
    const parsedHello = parseRequestParams('daemon.hello', req.p);
    const client = parsedHello.ok ? parsedHello.data.client : 'unknown client';

    this.identity.helloClient = client;

    // A principal the handshake cannot read would otherwise leave the
    // connection with the owner's reach.
    if (!parsedHello.ok && req.p?.['principal'] !== undefined) {
      this.reply.sendErr(req.id, 'bad_args', parsedHello.message);

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
    if (
      this.identity.peerSession !== null &&
      declared !== null &&
      declared !== this.identity.peerSession
    ) {
      this.reply.sendErr(
        req.id,
        'unauthorized',
        `daemon.hello gives session '${declared}', but the connecting process runs inside session '${this.identity.peerSession}'`,
      );

      return false;
    }

    this.identity.callerSession = this.identity.peerSession ?? declared;

    if (req.v !== PROTOCOL_V) {
      this.reply.sendErr(
        req.id,
        'protocol_mismatch',
        `${client} speaks protocol v${req.v}, daemon ${this.ctx.build} speaks v${PROTOCOL_V}; restart the daemon so both run the same build`,
      );

      return false;
    }

    this.helloed = true;
    this.helloAnswered = this.sendHelloOk(req.id);

    this.reply.answerAsync(req.id, () => this.helloAnswered);

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
        this.reply.sendErr(req.id, hello.code, hello.message);
        this.peer.end();

        return;
      }

      if (hello.principal !== null) {
        this.setPrincipal(hello.principal);
      }

      this.identity.callerSession = hello.session;
      this.identity.helloClient = hello.client;
      this.fingerprint = hello.fingerprint;

      await this.sendHelloOk(req.id);
    })();

    this.reply.answerAsync(req.id, () => this.helloAnswered);

    return true;
  }

  // Makes the connection act as the principal, its view starting as the
  // sessions the principal may see now, so one that leaves its reach later
  // is pushed as removed.
  private setPrincipal(principal: string): void {
    const access = this.ctx.buildTargetAccess(principal);

    this.identity.principal = principal;
    this.access = access;

    this.view.startView(access);
  }

  private async sendHelloOk(id: number): Promise<void> {
    const hello: DaemonAnswer<'daemon.hello'> = {
      daemon: this.ctx.build,
      daemonID: this.ctx.daemonID,
      limits: { maxLine: MAX_LINE, maxChunk: MAX_CHUNK },
      features: DAEMON_FEATURES,
      idempotency: { completedRetentionMs: this.ctx.idempotencyRetentionMs },
      lastUsedAgent: await this.ctx.loadLastUsedAgent(),
    };

    this.reply.sendAnswer(id, hello);
  }
}
