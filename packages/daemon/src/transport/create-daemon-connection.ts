import type { DaemonAnswer, MismatchRefusalData, RequestParams } from '@atc/protocol';
import {
  DEFAULT_QUEUE_BYTES,
  DaemonError,
  MAX_CHUNK,
  MAX_LINE,
  PROTOCOL_V,
  createLineDecoder,
  createOutboundQueue,
} from '@atc/protocol/wire';
import type { EventMsg, SocketWriter } from '@atc/protocol/wire';
import { DAEMON_FEATURES } from '@atcx/contract';
import type { SessionID } from '@atcx/contract';
import type { StandardRequest, StandardResponse } from '@orpc/standard-server';
import { ServerPeer } from '@orpc/standard-server-peer';
import type { EncodedMessage } from '@orpc/standard-server-peer';
import { createActor, waitFor } from 'xstate';
import type { EventFromLogic } from 'xstate';
import { buildGrantedContext } from '../auth/build-granted-context';
import { buildScopedContext } from '../auth/build-scoped-context';
import { buildSessionSetAccess } from '../auth/build-session-set-access';
import { buildTargetAccessFromGrants } from '../auth/build-target-access-from-grants';
import type { TargetAccess } from '../auth/build-target-access-from-grants';
import { GRANTED_METHOD_SCOPES } from '../auth/granted-method-scopes';
import { isOwnerOnlyMethod } from '../auth/is-owner-only-method';
import type { DaemonContext } from '../daemon-context';
import { answerPeerRequest } from './answer-peer-request';
import { buildConnectionRequests } from './build-connection-requests';
import { checkTCPHello } from './check-tcp-hello';
import { createConnectionView } from './create-connection-view';
import { createEventFeed } from './create-event-feed';
import { decodePeerInput } from './decode-peer-input';
import { findPeerMethod } from './find-peer-method';
import { isPeerMessage } from './is-peer-message';
import { parseRequestPrincipal } from './parse-request-principal';
import { PEER_CONNECTION_MACHINE } from './peer-connection-machine';
import type { ProcedureContext } from './procedure-context';
import type { ConnectionIdentity, RequestPrincipal } from './request-deps';
import type { TCPPeer } from './tcp-peer';
import { toPeerMethod } from './to-peer-method';

// One client connection, which speaks oRPC peer messages, one per line.
export interface DaemonConnection {
  readonly tokenFingerprint: string | null;

  // safe to call more than once
  readonly dispose: () => void;

  readonly sendEvent: (event: EventMsg) => void;

  readonly sendOutput: (sessionID: SessionID, event: EventMsg, byteLength: number) => void;

  // Decodes with state kept across reads, so a multi-byte character split
  // between two reads decodes whole.
  readonly decodeChunk: (buf: Uint8Array) => string;

  readonly applyChunk: (chunk: string) => void;

  readonly drain: () => void;

  // The peer wrote its last line: the connection ends once every request it
  // sent has its answer written.
  readonly endInput: () => void;
}

// The targets a request may use and the namespace of its idempotency keys.
interface RequestScope {
  readonly access: TargetAccess;
  readonly keyNamespace: string;
}

interface PeerSocket extends SocketWriter {
  readonly end: () => void;
}

// The session the connecting process runs inside: the kernel's answer on the
// local socket, or the session whose bridge socket a remote host connected
// through, which acts with that session's atc access alone.
export interface PeerSession {
  readonly id: SessionID;

  // Whether the bridge's binding still matches the live session; absent on
  // the local socket.
  readonly isBridgeCurrent?: () => boolean;
}

// A connection through a session's bridge socket.
interface BridgeGrant {
  readonly holder: SessionID;
  readonly isCurrent: () => boolean;
}

// tcp is the listener of a connection accepted over TCP, null on the local socket.
export function createDaemonConnection(
  peer: PeerSocket,
  ctx: DaemonContext,
  tcp: TCPPeer | null = null,
  connectingSession: PeerSession | null = null,
): DaemonConnection {
  const lines = createLineDecoder();
  const peerSession = connectingSession?.id ?? null;
  const isBridgeCurrent = connectingSession?.isBridgeCurrent;

  const grant: BridgeGrant | null =
    peerSession === null || isBridgeCurrent === undefined
      ? null
      : { holder: peerSession, isCurrent: isBridgeCurrent };

  // The targets the connection's principal may use; null for the daemon's
  // owner, whose reach has no limit.
  let connectionAccess: TargetAccess | null = null;

  // The fingerprint of the token a TCP handshake presented, set once the
  // handshake passes; null before then and on the local socket.
  let fingerprint: string | null = null;

  // Whether this TCP connection has sent its one handshake.
  let tcpHelloSent = false;

  // The TCP handshake whose token checked out, which its procedure applies.
  let acceptedTCPHello: Extract<Awaited<ReturnType<typeof checkTCPHello>>, { ok: true }> | null =
    null;

  let serverPeer: ServerPeer | null = null;

  // Sends waiting for the outbound queue to drain.
  let drainWaiters: (() => void)[] = [];

  const releaseDrainWaiters = (): void => {
    const waiters = drainWaiters;

    drainWaiters = [];

    for (const release of waiters) {
      release();
    }
  };

  const machine = PEER_CONNECTION_MACHINE.provide({
    actions: {
      endSocket: () => {
        peer.end();
      },
      releaseConnection: () => {
        serverPeer?.close();
        releaseDrainWaiters();
      },
    },
  });

  // Where the connection stands, from its handshake to its close; its
  // events and requests flow only while it is open.
  const lifecycle = createActor(machine).start();

  // Who the connection acts as, from its handshake and the kernel.
  const identity: ConnectionIdentity = {
    principal: null,
    callerSession: null,
    peerSession,
    helloClient: 'unknown client',
  };

  // What this connection sees of the fleet while its access is limited.
  const connectionView = createConnectionView(ctx);
  const queue = createOutboundQueue(peer, ctx.queueBytes);

  // A closed connection's machine has stopped, and takes no event.
  const sendLifecycleEvent = (event: EventFromLogic<typeof PEER_CONNECTION_MACHINE>): void => {
    if (lifecycle.getSnapshot().status === 'active') {
      lifecycle.send(event);
    }
  };

  const stopConnection = (): void => {
    sendLifecycleEvent({ type: 'END' });
  };

  const isIn = (state: 'awaiting' | 'checking' | 'open' | 'refusing' | 'closed'): boolean =>
    lifecycle.getSnapshot().matches(state);

  // Whether this connection may receive the session's output: always for
  // the daemon's owner, and otherwise only while its view holds the
  // session's whole tree.
  const canSeeOutput = (sessionID: SessionID): boolean =>
    connectionAccess === null || ctx.canSeeSession(sessionID, connectionAccess);

  // Whether this is a TCP connection whose handshake has not passed.
  const isUnauthenticatedTCP = (): boolean => tcp !== null && fingerprint === null;

  // The context a request over TCP runs on, scoped to the principal it acts
  // as; a refusal throws.
  const requireTCPRequestContext = (method: string, as: RequestPrincipal | null): DaemonContext => {
    if (isOwnerOnlyMethod(method)) {
      throw new DaemonError('unauthorized', `${method} is open to the daemon's owner only`);
    }

    if (as === null) {
      throw new DaemonError('unauthorized', 'a request over TCP must act as a principal with as');
    }

    if (!ctx.hasListedPrincipal(as.principal)) {
      tcp?.recordRefusedPrincipal();

      throw new DaemonError(
        'unauthorized',
        `principal '${as.principal}' is not listed in principals`,
      );
    }

    const scope = findRequestScope(as.principal);

    if (scope === null) {
      throw new DaemonError('internal', 'a request over TCP resolved to the owner scope');
    }

    return buildScopedContext(ctx, scope.access, scope.keyNamespace);
  };

  // The context a request through a session's bridge runs on: the scope its
  // method needs must be one the session holds now, under a binding that
  // still matches the live session; a refusal throws.
  const requireGrantedRequestContext = (
    bridge: BridgeGrant,
    method: string,
    as: RequestPrincipal | null,
  ): DaemonContext => {
    if (as !== null) {
      throw new DaemonError('unauthorized', "a session's atc access acts as no principal");
    }

    if (!bridge.isCurrent()) {
      throw new DaemonError(
        'unauthorized',
        `session '${bridge.holder}' started or moved again since this connection opened`,
      );
    }

    const held = ctx.findHeldAtcAccess(bridge.holder);

    if (held === null) {
      throw new DaemonError('unauthorized', `session '${bridge.holder}' holds no atc access`);
    }

    const needed = GRANTED_METHOD_SCOPES[method];

    if (needed === undefined) {
      throw new DaemonError('unauthorized', `${method} is closed to a session's atc access`);
    }

    if (needed !== 'any' && !held.scopes.includes(needed)) {
      throw new DaemonError(
        'unauthorized',
        `${method} needs atc scope ${needed}, which session '${bridge.holder}' does not hold`,
        { scope: needed },
      );
    }

    // A subscription delivers only what the connection's own view admits.
    if (method === 'events.subscribe') {
      return buildScopedContext(
        ctx,
        connectionAccess ?? buildTargetAccessFromGrants([]),
        `session:${bridge.holder}`,
      );
    }

    return buildGrantedContext(ctx, bridge.holder, held, method);
  };

  // The sessions a connection with a session's atc access receives events
  // of: the session and its subtree while it holds read, else none.
  const buildGrantedView = (bridge: BridgeGrant): TargetAccess => {
    const held = ctx.findHeldAtcAccess(bridge.holder);

    if (held === null || !held.scopes.includes('read')) {
      return buildTargetAccessFromGrants([]);
    }

    return buildSessionSetAccess(
      held.grant,
      (id) => id === bridge.holder || ctx.collectSubtree(bridge.holder).has(id),
    );
  };

  // Null is the daemon's owner. A connection that acts as a principal always keeps its own
  // idempotency keys, whatever principal a request acts as.
  const findRequestScope = (as: string | undefined): RequestScope | null => {
    if (as === undefined) {
      return identity.principal === null || connectionAccess === null
        ? null
        : { access: connectionAccess, keyNamespace: `client:${identity.principal}` };
    }

    const access = ctx.buildTargetAccess(as);

    if (identity.principal === null || connectionAccess === null) {
      return { access, keyNamespace: `client:${as}` };
    }

    return {
      access: connectionAccess.merge(access),
      keyNamespace: `client:${identity.principal}`,
    };
  };

  // The kernel's answer wins over the handshake: a process inside a session
  // acts as that session whether or not it gives one, and one that gives
  // another session is refused.
  const setCallerSession = (declared: SessionID | null): void => {
    if (identity.peerSession !== null && declared !== null && declared !== identity.peerSession) {
      throw new DaemonError(
        'unauthorized',
        `daemon.hello gives session '${declared}', but the connecting process runs inside session '${identity.peerSession}'`,
      );
    }

    identity.callerSession = identity.peerSession ?? declared;
  };

  const formatMismatch = (client: string, protocol: number | undefined): string => {
    const remedy =
      protocol !== undefined && protocol < PROTOCOL_V
        ? 'update or reopen the client'
        : 'restart the daemon';

    return `${client} speaks protocol v${protocol ?? 'unknown'}, daemon ${ctx.build} speaks v${PROTOCOL_V}; ${remedy} so both run the same build`;
  };

  // Makes the connection act as the principal, its view starting as the
  // sessions the principal may see now, so one that leaves its reach later
  // is pushed as removed.
  const setPrincipal = (principal: string): void => {
    const access = ctx.buildTargetAccess(principal);

    identity.principal = principal;
    connectionAccess = access;

    connectionView.startView(access);
  };

  const loadHelloAnswer = async (): Promise<DaemonAnswer<'daemon.hello'>> => ({
    daemon: ctx.build,
    daemonID: ctx.daemonID,
    limits: { maxLine: MAX_LINE, maxChunk: MAX_CHUNK },
    idempotency: { completedRetentionMs: ctx.idempotencyRetentionMs },
    lastUsedAgent: await ctx.loadLastUsedAgent(),
    peerSession: identity.peerSession,
    features: DAEMON_FEATURES,
  });

  const waitForDrain = async (): Promise<void> => {
    if (queue.queuedBytes === 0 || isIn('closed')) {
      return;
    }

    const drained = Promise.withResolvers<void>();

    drainWaiters.push(drained.resolve);

    await drained.promise;
  };

  // A full outbound queue ends the connection, as it does for an event; a
  // send waits for the queue to drain, so a slow client holds back its
  // subscription's events instead of the socket's buffer.
  const sendPeerMessage = async (message: EncodedMessage): Promise<void> => {
    if (typeof message !== 'string' || !queue.send(`${message}\n`)) {
      stopConnection();

      return;
    }

    const isRefusal = isIn('refusing');

    await waitForDrain();

    // A refusal ends the connection only once its bytes have left the
    // queue, so the client reads the refusal whole.
    if (isRefusal) {
      sendLifecycleEvent({ type: 'DRAINED' });
    }
  };

  const answerPeerHello = async (
    input: RequestParams<'daemon.hello'>,
  ): Promise<DaemonAnswer<'daemon.hello'>> => {
    const tcpHello = acceptedTCPHello;

    // A refused handshake leaves the connection's identity as it was.
    if (tcpHello === null) {
      if (input.protocol !== PROTOCOL_V) {
        throw new DaemonError('protocol_mismatch', formatMismatch(input.client, input.protocol), {
          daemonProtocol: PROTOCOL_V,
        } satisfies MismatchRefusalData);
      }

      if (grant !== null && input.principal !== undefined) {
        throw new DaemonError('unauthorized', "a session's atc access acts as no principal");
      }

      setCallerSession(input.session ?? null);

      identity.helloClient = input.client;

      if (input.principal !== undefined) {
        setPrincipal(input.principal);
      }
    } else {
      if (tcpHello.principal !== null) {
        setPrincipal(tcpHello.principal);
      }

      identity.callerSession = tcpHello.session;
      identity.helloClient = tcpHello.client;
      fingerprint = tcpHello.fingerprint;
    }

    const answer = await loadHelloAnswer();

    sendLifecycleEvent({ type: 'ACCEPT' });

    return answer;
  };

  const buildProcedureContext = (
    requestCtx: DaemonContext,
    as: RequestPrincipal | null,
  ): ProcedureContext => ({
    ctx: requestCtx,
    requests,
    as,
    answerHello: (input) => answerPeerHello(input),
    subscribeEvents: (signal) => feed.subscribe(signal),
  });

  // A TCP handshake checks its token before anything else, so a peer
  // without one learns nothing about the daemon.
  const checkPeerHello = async (
    request: StandardRequest,
  ): Promise<ProcedureContext | DaemonError> => {
    const raw = decodePeerInput(request);

    if (tcp !== null) {
      const protocol = raw['protocol'];

      const hello = await checkTCPHello(
        {
          version: typeof protocol === 'number' ? protocol : 0,
          id: 0,
          method: 'daemon.hello',
          params: raw,
        },
        {
          tcp,
          hasListedPrincipal: (principal) => ctx.hasListedPrincipal(principal),
          build: ctx.build,
        },
      );

      if (!hello.ok) {
        return new DaemonError(hello.code, hello.message);
      }

      acceptedTCPHello = hello;
    }

    return buildProcedureContext(ctx, null);
  };

  const checkPeerRequest = async (
    method: string,
    request: StandardRequest,
  ): Promise<ProcedureContext | DaemonError> => {
    if (isIn('awaiting')) {
      sendLifecycleEvent({ type: 'REFUSE' });

      return new DaemonError('unauthorized', 'daemon.hello must be the first request');
    }

    await waitFor(lifecycle, (snapshot) => !snapshot.matches('checking'));

    if (isIn('refusing')) {
      return new DaemonError('unauthorized', 'the handshake was refused');
    }

    if (!isIn('open')) {
      return new DaemonError('unauthorized', 'the connection is closing');
    }

    try {
      const as = parseRequestPrincipal(request.headers);

      if (grant !== null) {
        return buildProcedureContext(requireGrantedRequestContext(grant, method, as), null);
      }

      // A subscription delivers only what the connection's own view admits,
      // so over TCP it needs no principal of its own.
      if (tcp !== null && method === 'events.subscribe' && as === null) {
        const access = connectionAccess ?? buildTargetAccessFromGrants([]);
        const eventsCtx = buildScopedContext(ctx, access, 'client:events');

        return buildProcedureContext(eventsCtx, null);
      }

      if (tcp !== null) {
        return buildProcedureContext(requireTCPRequestContext(method, as), as);
      }

      const scope = findRequestScope(as?.principal);

      if (scope !== null && isOwnerOnlyMethod(method)) {
        return new DaemonError('unauthorized', `${method} is open to the daemon's owner only`);
      }

      const requestCtx =
        scope === null ? ctx : buildScopedContext(ctx, scope.access, scope.keyNamespace);

      return buildProcedureContext(requestCtx, as);
    } catch (error) {
      if (error instanceof DaemonError) {
        return error;
      }

      throw error;
    }
  };

  // A second handshake could change the principal under kept attachments,
  // so a connection takes one.
  const answerPeerHandshake = async (request: StandardRequest): Promise<StandardResponse> => {
    if (!isIn('awaiting')) {
      return answerPeerRequest(
        request,
        new DaemonError('unauthorized', 'a connection takes one handshake'),
      );
    }

    sendLifecycleEvent({ type: 'HELLO' });

    const admitted = await checkPeerHello(request);
    const response = await answerPeerRequest(request, admitted);

    // The handshake procedure accepts the connection; anything else it
    // answers refuses it.
    if (isIn('checking')) {
      sendLifecycleEvent({ type: 'REFUSE' });
    }

    return response;
  };

  // The handshake settles before any other request is admitted; one that
  // fails ends the connection once its refusal is written.
  const answerPeer = async (request: StandardRequest): Promise<StandardResponse> => {
    const method = toPeerMethod(request.url.pathname);

    // A path in any form but the procedure's own names no procedure, and
    // before the handshake it ends the connection as any other request does.
    if (method === null) {
      if (isIn('awaiting')) {
        sendLifecycleEvent({ type: 'REFUSE' });
      }

      return answerPeerRequest(
        request,
        new DaemonError('unknown_method', `unknown method '${request.url.pathname}'`),
      );
    }

    if (method === 'daemon.hello') {
      return answerPeerHandshake(request);
    }

    const admitted = await checkPeerRequest(method, request);

    return answerPeerRequest(request, admitted);
  };

  // false: the connection is beyond recovery and gets closed. A line goes to
  // the connection's oRPC peer. Until its token checks out, a TCP connection
  // takes one handshake line and nothing else.
  const applyLine = (line: string): boolean => {
    const isPeer = isPeerMessage(line);

    if (isUnauthenticatedTCP()) {
      if (!isPeer || tcpHelloSent || findPeerMethod(line) !== 'daemon.hello') {
        tcp?.recordFailure('unexpected_line');

        return false;
      }

      tcpHelloSent = true;
    }

    if (!isPeer) {
      return false;
    }

    serverPeer ??= new ServerPeer((message) => sendPeerMessage(message));

    const openPeer = serverPeer;

    // An event subscription answers until the connection ends, so the end of
    // input waits on every other request alone.
    const isAwaited = findPeerMethod(line) !== 'events.subscribe';

    if (isAwaited) {
      inFlight += 1;
    }

    // A line the peer cannot decode ends the connection.
    void (async () => {
      try {
        await openPeer.message(line, (request) => answerPeer(request));
      } catch {
        stopConnection();
      }

      if (isAwaited) {
        inFlight -= 1;

        endWhenSettled();
      }
    })();

    return true;
  };

  // Requests read but not yet answered, and whether the peer has written
  // its last line.
  let inFlight = 0;
  let isInputEnded = false;

  const endWhenSettled = (): void => {
    if (isInputEnded && inFlight === 0 && queue.queuedBytes === 0) {
      stopConnection();
    }
  };

  const self: DaemonConnection = {
    get tokenFingerprint() {
      return fingerprint;
    },

    dispose: () => {
      sendLifecycleEvent({ type: 'CLOSE' });
    },

    sendEvent: (event) => {
      if (!isIn('open')) {
        return;
      }

      const view =
        connectionAccess === null
          ? { events: [event], withdrawn: [] }
          : connectionView.updateView(event, connectionAccess);

      for (const visible of view.events) {
        feed.emit(visible);
      }

      // Output and inbox messages of a session that left the view stop with
      // it. The detach runs once the view is settled, since it emits an event
      // of its own.
      for (const id of view.withdrawn) {
        feed.forgetSession(id);
        ctx.detachSession(self, id);
        ctx.detachTap(self, id);
      }
    },

    sendOutput: (sessionID, event, byteLength) => {
      if (!isIn('open') || !canSeeOutput(sessionID)) {
        return;
      }

      feed.emitOutput(sessionID, event, byteLength);
    },

    decodeChunk: (buf) => lines.decodeText(buf),

    applyChunk: (chunk) => {
      if (isIn('closed')) {
        return;
      }

      if (lines.pendingLength + chunk.length > MAX_LINE) {
        if (isUnauthenticatedTCP()) {
          tcp?.recordFailure('line_too_long');
        }

        stopConnection();

        return;
      }

      for (const line of lines.splitText(chunk)) {
        if (!applyLine(line)) {
          stopConnection();

          return;
        }
      }
    },

    drain: () => {
      queue.drain();

      if (queue.queuedBytes === 0) {
        releaseDrainWaiters();
        endWhenSettled();
      }
    },

    endInput: () => {
      isInputEnded = true;

      endWhenSettled();
    },
  };

  const requests = buildConnectionRequests({ client: self, ctx, identity });

  // The connection's events, delivered through its subscription.
  const feed = createEventFeed({
    capacity: ctx.queueBytes ?? DEFAULT_QUEUE_BYTES,
    canSeeOutput: (sessionID) => canSeeOutput(sessionID),
    resync: (sessionID) => {
      void ctx.resyncClient(sessionID, self);
    },
    onOverflow: () => {
      stopConnection();
    },
  });

  // A TCP connection acts only as the principals its requests give, so
  // the events pushed to it are limited from the first byte.
  if (tcp !== null) {
    connectionAccess = buildTargetAccessFromGrants([]);
  }

  if (grant !== null) {
    connectionAccess = buildGrantedView(grant);

    connectionView.startView(connectionAccess);
  }

  return self;
}
