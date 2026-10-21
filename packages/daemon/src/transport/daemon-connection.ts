import type { SessionID } from '@atc/core';
import type { DaemonAnswer, MismatchRefusalData, RequestParams } from '@atc/protocol';
import {
  DEFAULT_QUEUE_BYTES,
  DaemonError,
  LineDecoder,
  MAX_CHUNK,
  MAX_LINE,
  OutboundQueue,
  PROTOCOL_V,
} from '@atc/protocol/wire';
import type { EventMsg, SocketWriter } from '@atc/protocol/wire';
import type { StandardRequest, StandardResponse } from '@orpc/standard-server';
import { ServerPeer } from '@orpc/standard-server-peer';
import type { EncodedMessage } from '@orpc/standard-server-peer';
import { createActor, waitFor } from 'xstate';
import type { Actor, EventFromLogic } from 'xstate';
import { buildScopedContext } from '../auth/build-scoped-context';
import { isOwnerOnlyMethod } from '../auth/is-owner-only-method';
import { TargetAccess } from '../auth/target-access';
import type { DaemonContext } from '../daemon-context';
import { answerPeerRequest } from './answer-peer-request';
import { buildConnectionRequests } from './build-connection-requests';
import type { ConnectionRequests } from './build-connection-requests';
import { checkTCPHello } from './check-tcp-hello';
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

// One client connection, which speaks oRPC peer messages, one per line.
export class DaemonConnection {
  private readonly peer: PeerSocket;

  private readonly ctx: DaemonContext;

  private readonly queue: OutboundQueue;

  private readonly lines = new LineDecoder();

  // Where the connection stands, from its handshake to its close; its
  // events and requests flow only while it is open.
  private readonly lifecycle: Actor<typeof PEER_CONNECTION_MACHINE>;

  // Who the connection acts as, from its handshake and the kernel.
  private readonly identity: ConnectionIdentity;

  // The targets the connection's principal may use; null for the daemon's
  // owner, whose reach has no limit.
  private access: TargetAccess | null = null;

  // What this connection sees of the fleet while its access is limited.
  private readonly view: ConnectionView;

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

  // The connection's events, delivered through its subscription.
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
    this.sendLifecycleEvent({ type: 'CLOSE' });
  }

  // A closed connection's machine has stopped, and takes no event.
  private sendLifecycleEvent(event: EventFromLogic<typeof PEER_CONNECTION_MACHINE>): void {
    if (this.lifecycle.getSnapshot().status === 'active') {
      this.lifecycle.send(event);
    }
  }

  private stopConnection(): void {
    this.sendLifecycleEvent({ type: 'END' });
  }

  private isIn(state: 'awaiting' | 'checking' | 'open' | 'refusing' | 'closed'): boolean {
    return this.lifecycle.getSnapshot().matches(state);
  }

  sendEvent(event: EventMsg): void {
    if (!this.isIn('open')) {
      return;
    }

    const view =
      this.access === null
        ? { events: [event], withdrawn: [] }
        : this.view.updateView(event, this.access);

    for (const visible of view.events) {
      this.feed.emit(visible);
    }

    // Output and inbox messages of a session that left the view stop with
    // it. The detach runs once the view is settled, since it emits an event
    // of its own.
    for (const id of view.withdrawn) {
      this.feed.forgetSession(id);
      this.ctx.detachSession(this, id);
      this.ctx.detachTap(this, id);
    }
  }

  sendOutput(sessionID: SessionID, event: EventMsg, byteLength: number): void {
    if (!this.isIn('open') || !this.canSeeOutput(sessionID)) {
      return;
    }

    this.feed.emitOutput(sessionID, event, byteLength);
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

    if (this.lines.pendingLength + chunk.length > MAX_LINE) {
      if (this.isUnauthenticatedTCP()) {
        this.tcp?.recordFailure('line_too_long');
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
  }

  // Whether this connection may receive the session's output: always for
  // the daemon's owner, and otherwise only while its view holds the
  // session's whole tree.
  private canSeeOutput(sessionID: SessionID): boolean {
    return this.access === null || this.ctx.canSeeSession(sessionID, this.access);
  }

  // false: the connection is beyond recovery and gets closed. A line goes to
  // the connection's oRPC peer. Until its token checks out, a TCP connection
  // takes one handshake line and nothing else.
  private applyLine(line: string): boolean {
    const isPeer = isPeerMessage(line);

    if (this.isUnauthenticatedTCP()) {
      if (!isPeer || this.tcpHelloSent || findPeerMethod(line) !== 'daemon.hello') {
        this.tcp?.recordFailure('unexpected_line');

        return false;
      }

      this.tcpHelloSent = true;
    }

    if (!isPeer) {
      return false;
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

  // Whether this is a TCP connection whose handshake has not passed.
  private isUnauthenticatedTCP(): boolean {
    return this.tcp !== null && this.fingerprint === null;
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
    const remedy =
      protocol !== undefined && protocol < PROTOCOL_V
        ? 'update or reopen the client'
        : 'restart the daemon';

    return `${client} speaks protocol v${protocol ?? 'unknown'}, daemon ${this.ctx.build} speaks v${PROTOCOL_V}; ${remedy} so both run the same build`;
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

  private async loadHelloAnswer(): Promise<DaemonAnswer<'daemon.hello'>> {
    return {
      daemon: this.ctx.build,
      daemonID: this.ctx.daemonID,
      limits: { maxLine: MAX_LINE, maxChunk: MAX_CHUNK },
      idempotency: { completedRetentionMs: this.ctx.idempotencyRetentionMs },
      lastUsedAgent: await this.ctx.loadLastUsedAgent(),
    };
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
      this.sendLifecycleEvent({ type: 'DRAINED' });
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
        this.sendLifecycleEvent({ type: 'REFUSE' });
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

    this.sendLifecycleEvent({ type: 'HELLO' });

    const admitted = await this.checkPeerHello(request);
    const response = await answerPeerRequest(request, admitted);

    // The handshake procedure accepts the connection; anything else it
    // answers refuses it.
    if (this.isIn('checking')) {
      this.sendLifecycleEvent({ type: 'REFUSE' });
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
        {
          version: typeof protocol === 'number' ? protocol : 0,
          id: 0,
          method: 'daemon.hello',
          params: raw,
        },
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

    return this.buildProcedureContext(this.ctx, null);
  }

  private async checkPeerRequest(
    method: string,
    request: StandardRequest,
  ): Promise<ProcedureContext | DaemonError> {
    if (this.isIn('awaiting')) {
      this.sendLifecycleEvent({ type: 'REFUSE' });

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

      // A subscription delivers only what the connection's own view admits,
      // so over TCP it needs no principal of its own.
      if (this.tcp !== null && method === 'events.subscribe' && as === null) {
        const access = this.access ?? new TargetAccess([]);
        const ctx = buildScopedContext(this.ctx, access, 'client:events');

        return this.buildProcedureContext(ctx, null);
      }

      if (this.tcp !== null) {
        return this.buildProcedureContext(this.requireTCPRequestContext(method, as), as);
      }

      const scope = this.findRequestScope(as?.principal);

      if (scope !== null && isOwnerOnlyMethod(method)) {
        return new DaemonError('unauthorized', `${method} is open to the daemon's owner only`);
      }

      const ctx =
        scope === null ? this.ctx : buildScopedContext(this.ctx, scope.access, scope.keyNamespace);

      return this.buildProcedureContext(ctx, as);
    } catch (error) {
      if (error instanceof DaemonError) {
        return error;
      }

      throw error;
    }
  }

  private buildProcedureContext(ctx: DaemonContext, as: RequestPrincipal | null): ProcedureContext {
    return {
      ctx,
      requests: this.requests,
      as,
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
          { daemonProtocol: PROTOCOL_V } satisfies MismatchRefusalData,
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

    this.sendLifecycleEvent({ type: 'ACCEPT' });

    return answer;
  }
}
