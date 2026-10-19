import type { SessionID } from '@atc/core';
import { DAEMON_FEATURES, parseRequestParams } from '@atc/protocol';
import type { DaemonAnswer, RequestParams } from '@atc/protocol';
import {
  DEFAULT_QUEUE_BYTES,
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
import type { StandardRequest, StandardResponse } from '@orpc/standard-server';
import { ServerPeer } from '@orpc/standard-server-peer';
import type { EncodedMessage } from '@orpc/standard-server-peer';
import { createActor, waitFor } from 'xstate';
import type { Actor } from 'xstate';
import { buildScopedContext } from '../auth/build-scoped-context';
import { isOwnerOnlyMethod } from '../auth/is-owner-only-method';
import { TargetAccess } from '../auth/target-access';
import type { DaemonContext } from '../daemon-context';
import { answerPeerRequest } from './answer-peer-request';
import { buildConnectionRequests } from './build-connection-requests';
import type { ConnectionRequests } from './build-connection-requests';
import { checkTCPHello } from './check-tcp-hello';
import { ConnectionReply } from './connection-reply';
import { ConnectionView } from './connection-view';
import { createEventFeed } from './create-event-feed';
import type { EventFeed } from './create-event-feed';
import { decodePeerInput } from './decode-peer-input';
import { findPeerMethod } from './find-peer-method';
import { isPeerMessage } from './is-peer-message';
import { parseRequestPrincipal } from './parse-request-principal';
import { PEER_CONNECTION_MACHINE } from './peer-connection-machine';
import type { ProcedureContext } from './procedure-context';
import type { ConnectionIdentity, RequestPrincipal } from './request-deps';
import { runDaemonProcedure } from './run-daemon-procedure';
import type { TCPPeer } from './tcp-peer';
import { toPeerMethod } from './to-peer-method';

// The targets a request may use and the namespace of its idempotency keys.
interface RequestScope {
  readonly access: TargetAccess;
  readonly keyNamespace: string;
}

interface PeerSocket extends SocketWriter {
  readonly end: () => void;
}

// How the client frames its requests, which its first line settles: oRPC
// peer messages, or the line protocol's requests.
type Dialect = 'peer' | 'line';

export class DaemonConnection {
  private readonly peer: PeerSocket;

  private readonly ctx: DaemonContext;

  private readonly queue: OutboundQueue;

  private readonly lines = new LineDecoder();

  private dialect: Dialect | null = null;

  // Whether a line client has sent its handshake.
  private helloed = false;

  // Where the connection stands, from its handshake to its close; a peer
  // client's events and requests flow only while it is open.
  private readonly lifecycle: Actor<typeof PEER_CONNECTION_MACHINE>;

  // A line client's handshake answer is written before any other response
  // on this connection, even though building it reads the store: a request
  // that arrives while that read is in flight waits behind it.
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

  // The TCP handshake whose token checked out, which its procedure applies.
  private acceptedTCPHello: Extract<
    Awaited<ReturnType<typeof checkTCPHello>>,
    { ok: true }
  > | null = null;

  private serverPeer: ServerPeer | null = null;

  // A peer client's events, delivered through its subscription.
  private readonly feed: EventFeed;

  // Sends waiting for the outbound queue to drain.
  private drainWaiters: (() => void)[] = [];

  constructor(
    peer: PeerSocket,
    ctx: DaemonContext,
    tcp: TCPPeer | null = null,
    peerSession: SessionID | null = null,
  ) {
    this.peer = peer;
    this.ctx = ctx;
    this.tcp = tcp;

    const machine = PEER_CONNECTION_MACHINE.provide({
      actions: {
        endSocket: () => {
          this.peer.end();
        },
        releaseConnection: () => {
          this.serverPeer?.close();
          this.releaseDrainWaiters();
        },
      },
    });

    this.lifecycle = createActor(machine).start();

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

    this.feed = createEventFeed({
      capacity: ctx.queueBytes ?? DEFAULT_QUEUE_BYTES,
      canSeeOutput: (sessionID) => this.canSeeOutput(sessionID),
      resync: (sessionID) => {
        void this.ctx.resyncClient(sessionID, this);
      },
      onOverflow: () => {
        this.stopConnection();
      },
    });

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
    this.lifecycle.send({ type: 'CLOSE' });
  }

  private stopConnection(): void {
    this.lifecycle.send({ type: 'END' });
  }

  private isIn(state: 'awaiting' | 'checking' | 'open' | 'refusing' | 'closed'): boolean {
    return this.lifecycle.getSnapshot().matches(state);
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
      if (this.dialect === 'peer') {
        this.feed.emit(visible);
      } else if (!this.queue.send(encodeMessage(visible))) {
        this.stopConnection();

        return;
      }
    }

    // Output and inbox messages of a session that left the view stop with
    // it. The detach runs once the view is settled, since it emits an event
    // of its own.
    for (const id of view.withdrawn) {
      this.desynced.delete(id);
      this.feed.forgetSession(id);
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

    if (this.dialect === 'peer') {
      this.feed.emitOutput(sessionID, event, byteLength);

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
    if (this.dialect === 'peer') {
      return this.isIn('open');
    }

    return this.helloed && (this.tcp === null || this.fingerprint !== null);
  }

  // Decodes with state kept across reads, so a multi-byte character split
  // between two reads decodes whole.
  decodeChunk(buf: Uint8Array): string {
    return this.lines.decodeText(buf);
  }

  applyChunk(chunk: string): void {
    if (this.isIn('closed')) {
      return;
    }

    const oversized = this.lines.pendingLength + chunk.length > MAX_LINE;

    if (oversized && this.isUnauthenticatedTCP()) {
      this.tcp?.recordFailure('line_too_long');
      this.stopConnection();

      return;
    }

    if (oversized) {
      if (this.dialect !== 'peer') {
        this.reply.sendErr(0, 'bad_args', `line exceeds ${MAX_LINE} bytes`);
      }

      this.stopConnection();

      return;
    }

    for (const line of this.lines.splitText(chunk)) {
      if (!this.applyLine(line)) {
        this.stopConnection();

        return;
      }
    }
  }

  drain(): void {
    this.queue.drain();

    if (this.queue.queuedBytes === 0) {
      this.releaseDrainWaiters();
    }

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
    this.dialect ??= isPeerMessage(line) ? 'peer' : 'line';

    if (this.dialect === 'peer') {
      return this.applyPeerLine(line);
    }

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

    const scope = this.findRequestScope(req.as);

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

    const as = req.as === undefined ? null : { principal: req.as, name: req.asName };
    const ctx = this.requireTCPRequestContext(req.m, as);

    await this.applyRequest(req, ctx);
  }

  // The context a request over TCP runs on, scoped to the principal it acts
  // as; a refusal throws.
  private requireTCPRequestContext(method: string, as: RequestPrincipal | null): DaemonContext {
    if (isOwnerOnlyMethod(method)) {
      throw new DaemonError('unauthorized', `${method} is open to the daemon's owner only`);
    }

    if (as === null) {
      throw new DaemonError('unauthorized', 'a request over TCP must act as a principal with as');
    }

    if (!this.ctx.hasListedPrincipal(as.principal)) {
      this.tcp?.recordRefusedPrincipal();

      throw new DaemonError(
        'unauthorized',
        `principal '${as.principal}' is not listed in principals`,
      );
    }

    const scope = this.findRequestScope(as.principal);

    if (scope === null) {
      throw new DaemonError('internal', 'a request over TCP resolved to the owner scope');
    }

    return buildScopedContext(this.ctx, scope.access, scope.keyNamespace);
  }

  // Null is the daemon's owner. A connection that acts as a principal always keeps its own
  // idempotency keys, whatever principal a request acts as.
  private findRequestScope(as: string | undefined): RequestScope | null {
    if (as === undefined) {
      return this.identity.principal === null || this.access === null
        ? null
        : { access: this.access, keyNamespace: `client:${this.identity.principal}` };
    }

    const access = this.ctx.buildTargetAccess(as);

    if (this.identity.principal === null || this.access === null) {
      return { access, keyNamespace: `client:${as}` };
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

    try {
      this.setCallerSession(declared);
    } catch (error) {
      if (error instanceof DaemonError) {
        this.reply.sendErr(req.id, error.code, error.message);
      }

      return false;
    }

    if (req.v !== PROTOCOL_V) {
      this.reply.sendErr(req.id, 'protocol_mismatch', this.formatMismatch(client, req.v));

      return false;
    }

    this.helloed = true;
    this.helloAnswered = this.sendHelloOk(req.id);

    this.reply.answerAsync(req.id, () => this.helloAnswered);

    return true;
  }

  // The kernel's answer wins over the handshake: a process inside a session
  // acts as that session whether or not it gives one, and one that gives
  // another session is refused.
  private setCallerSession(declared: SessionID | null): void {
    if (
      this.identity.peerSession !== null &&
      declared !== null &&
      declared !== this.identity.peerSession
    ) {
      throw new DaemonError(
        'unauthorized',
        `daemon.hello gives session '${declared}', but the connecting process runs inside session '${this.identity.peerSession}'`,
      );
    }

    this.identity.callerSession = this.identity.peerSession ?? declared;
  }

  private formatMismatch(client: string, protocol: number | undefined): string {
    return `${client} speaks protocol v${protocol ?? 'unknown'}, daemon ${this.ctx.build} speaks v${PROTOCOL_V}; restart the daemon so both run the same build`;
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
        this.stopConnection();

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
    const answer = await this.loadHelloAnswer();

    this.reply.sendAnswer(id, answer);
  }

  private async loadHelloAnswer(): Promise<DaemonAnswer<'daemon.hello'>> {
    return {
      daemon: this.ctx.build,
      daemonID: this.ctx.daemonID,
      limits: { maxLine: MAX_LINE, maxChunk: MAX_CHUNK },
      features: DAEMON_FEATURES,
      idempotency: { completedRetentionMs: this.ctx.idempotencyRetentionMs },
      lastUsedAgent: await this.ctx.loadLastUsedAgent(),
    };
  }

  // A peer line goes to the connection's oRPC peer. Until its token checks
  // out, a TCP connection takes one handshake line and nothing else.
  private applyPeerLine(line: string): boolean {
    if (this.isUnauthenticatedTCP()) {
      if (this.tcpHelloSent || findPeerMethod(line) !== 'daemon.hello') {
        this.tcp?.recordFailure('unexpected_line');

        return false;
      }

      this.tcpHelloSent = true;
    }

    this.serverPeer ??= new ServerPeer((message) => this.sendPeerMessage(message));

    const serverPeer = this.serverPeer;

    // A line the peer cannot decode ends the connection.
    void (async () => {
      try {
        await serverPeer.message(line, (request) => this.answerPeer(request));
      } catch {
        this.stopConnection();
      }
    })();

    return true;
  }

  // A full outbound queue ends the connection, as it does for an event; a
  // send waits for the queue to drain, so a slow client holds back its
  // subscription's events instead of the socket's buffer.
  private async sendPeerMessage(message: EncodedMessage): Promise<void> {
    if (typeof message !== 'string' || !this.queue.send(`${message}\n`)) {
      this.stopConnection();

      return;
    }

    const isRefusal = this.isIn('refusing');

    await this.waitForDrain();

    // A refusal ends the connection only once its bytes have left the
    // queue, so the client reads the refusal whole.
    if (isRefusal) {
      this.lifecycle.send({ type: 'DRAINED' });
    }
  }

  private async waitForDrain(): Promise<void> {
    if (this.queue.queuedBytes === 0 || this.isIn('closed')) {
      return;
    }

    const drained = Promise.withResolvers<void>();

    this.drainWaiters.push(drained.resolve);

    await drained.promise;
  }

  private releaseDrainWaiters(): void {
    const waiters = this.drainWaiters;

    this.drainWaiters = [];

    for (const release of waiters) {
      release();
    }
  }

  // The handshake settles before any other request is admitted; one that
  // fails ends the connection once its refusal is written.
  private async answerPeer(request: StandardRequest): Promise<StandardResponse> {
    const method = toPeerMethod(request.url.pathname);

    // A path in any form but the procedure's own names no procedure, and
    // before the handshake it ends the connection as any other request does.
    if (method === null) {
      if (this.isIn('awaiting')) {
        this.lifecycle.send({ type: 'REFUSE' });
      }

      return answerPeerRequest(
        request,
        new DaemonError('unknown_method', `unknown method '${request.url.pathname}'`),
      );
    }

    if (method === 'daemon.hello') {
      return this.answerPeerHandshake(request);
    }

    const admitted = await this.checkPeerRequest(method, request);

    return answerPeerRequest(request, admitted);
  }

  // A second handshake could change the principal under kept attachments,
  // so a connection takes one.
  private async answerPeerHandshake(request: StandardRequest): Promise<StandardResponse> {
    if (!this.isIn('awaiting')) {
      return answerPeerRequest(
        request,
        new DaemonError('unauthorized', 'a connection takes one handshake'),
      );
    }

    this.lifecycle.send({ type: 'HELLO' });

    const admitted = await this.checkPeerHello(request);
    const response = await answerPeerRequest(request, admitted);

    // The handshake procedure accepts the connection; anything else it
    // answers refuses it.
    if (this.isIn('checking')) {
      this.lifecycle.send({ type: 'REFUSE' });
    }

    return response;
  }

  // A TCP handshake checks its token before anything else, so a peer
  // without one learns nothing about the daemon.
  private async checkPeerHello(request: StandardRequest): Promise<ProcedureContext | DaemonError> {
    const raw = decodePeerInput(request);

    if (this.tcp !== null) {
      const protocol = raw['protocol'];

      const hello = await checkTCPHello(
        { v: typeof protocol === 'number' ? protocol : 0, id: 0, m: 'daemon.hello', p: raw },
        {
          tcp: this.tcp,
          hasListedPrincipal: (principal) => this.ctx.hasListedPrincipal(principal),
          build: this.ctx.build,
        },
      );

      if (!hello.ok) {
        return new DaemonError(hello.code, hello.message);
      }

      this.acceptedTCPHello = hello;
    }

    return this.buildProcedureContext(this.ctx, null, raw);
  }

  private async checkPeerRequest(
    method: string,
    request: StandardRequest,
  ): Promise<ProcedureContext | DaemonError> {
    if (this.isIn('awaiting')) {
      this.lifecycle.send({ type: 'REFUSE' });

      return new DaemonError('unauthorized', 'daemon.hello must be the first request');
    }

    await waitFor(this.lifecycle, (snapshot) => !snapshot.matches('checking'));

    if (this.isIn('refusing')) {
      return new DaemonError('unauthorized', 'the handshake was refused');
    }

    if (!this.isIn('open')) {
      return new DaemonError('unauthorized', 'the connection is closing');
    }

    try {
      const as = parseRequestPrincipal(request.headers);
      const sent = decodePeerInput(request);

      if (this.tcp !== null) {
        return this.buildProcedureContext(this.requireTCPRequestContext(method, as), as, sent);
      }

      const scope = this.findRequestScope(as?.principal);

      if (scope !== null && isOwnerOnlyMethod(method)) {
        return new DaemonError('unauthorized', `${method} is open to the daemon's owner only`);
      }

      const ctx =
        scope === null ? this.ctx : buildScopedContext(this.ctx, scope.access, scope.keyNamespace);

      return this.buildProcedureContext(ctx, as, sent);
    } catch (error) {
      if (error instanceof DaemonError) {
        return error;
      }

      throw error;
    }
  }

  private buildProcedureContext(
    ctx: DaemonContext,
    as: RequestPrincipal | null,
    sentParams: Readonly<Record<string, unknown>>,
  ): ProcedureContext {
    return {
      ctx,
      requests: this.requests,
      as,
      sentParams,
      answerHello: (input) => this.answerPeerHello(input),
      subscribeEvents: (signal) => this.feed.subscribe(signal),
    };
  }

  private async answerPeerHello(
    input: RequestParams<'daemon.hello'>,
  ): Promise<DaemonAnswer<'daemon.hello'>> {
    const tcpHello = this.acceptedTCPHello;

    // A refused handshake leaves the connection's identity as it was.
    if (tcpHello === null) {
      if (input.protocol !== PROTOCOL_V) {
        throw new DaemonError(
          'protocol_mismatch',
          this.formatMismatch(input.client, input.protocol),
        );
      }

      this.setCallerSession(input.session ?? null);

      this.identity.helloClient = input.client;

      if (input.principal !== undefined) {
        this.setPrincipal(input.principal);
      }
    } else {
      if (tcpHello.principal !== null) {
        this.setPrincipal(tcpHello.principal);
      }

      this.identity.callerSession = tcpHello.session;
      this.identity.helloClient = tcpHello.client;
      this.fingerprint = tcpHello.fingerprint;
    }

    const answer = await this.loadHelloAnswer();

    this.lifecycle.send({ type: 'ACCEPT' });

    return answer;
  }
}
