import type { DaemonAnswer, RequestParams } from '@atc/protocol';
import {
  DEFAULT_QUEUE_BYTES,
  MAX_LINE,
  PROTOCOL_V,
  createLineDecoder,
  createOutboundQueue,
} from '@atc/protocol/wire';
import type { EventMsg, SocketWriter } from '@atc/protocol/wire';
import type { SessionID } from '@atcx/contract';
import { AtcError, CONTRACT_MAJOR } from '@atcx/contract/light';
import type { StandardRequest, StandardResponse } from '@orpc/standard-server';
import { ServerPeer } from '@orpc/standard-server-peer';
import type { EncodedMessage } from '@orpc/standard-server-peer';
import { createActor, waitFor } from 'xstate';
import type { EventFromLogic } from 'xstate';
import { buildGrantedEventAccess } from '../auth/build-granted-event-access';
import { buildScopedContext } from '../auth/build-scoped-context';
import { buildTargetAccessFromGrants } from '../auth/build-target-access-from-grants';
import type { TargetAccess } from '../auth/build-target-access-from-grants';
import { isOwnerOnlyMethod } from '../auth/is-owner-only-method';
import type { DaemonContext } from '../types';
import { answerPeerRequest } from './answer-peer-request';
import { buildConnectionRequests } from './build-connection-requests';
import { checkHelloMajor } from './check-hello-major';
import { checkTCPHello } from './check-tcp-hello';
import { createConnectionView } from './create-connection-view';
import { createEventFeed } from './create-event-feed';
import { decodePeerInput } from './decode-peer-input';
import { findPeerMethod } from './find-peer-method';
import { findRequestScope } from './find-request-scope';
import { isPeerMessage } from './is-peer-message';
import { loadHelloAnswer } from './load-hello-answer';
import { parseRequestPrincipal } from './parse-request-principal';
import { PEER_CONNECTION_MACHINE } from './peer-connection-machine';
import type { ProcedureContext } from './procedure-context';
import type { ConnectionIdentity, RequestPrincipal } from './request-deps';
import { requireGrantedRequestContext } from './require-granted-request-context';
import { requireTCPRequestContext } from './require-tcp-request-context';
import { resolveCallerSession } from './resolve-caller-session';
import type { TCPPeer } from './tcp-peer';
import { toPeerMethod } from './to-peer-method';
import type { BridgeGrant } from './types';

export interface DaemonConnection {
  readonly tokenFingerprint: string | null;

  readonly dispose: () => void;

  readonly sendEvent: (event: EventMsg) => void;

  readonly sendOutput: (sessionID: SessionID, event: EventMsg, byteLength: number) => void;

  readonly decodeChunk: (buf: Uint8Array) => string;

  readonly applyChunk: (chunk: string) => void;

  readonly drain: () => void;

  readonly endInput: () => void;
}

interface PeerSocket extends SocketWriter {
  readonly end: () => void;
}

export interface PeerSession {
  readonly id: SessionID;

  readonly isBridgeCurrent?: () => boolean;
}

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

  let connectionAccess: TargetAccess | null = null;
  let fingerprint: string | null = null;
  let tcpHelloSent = false;

  let acceptedTCPHello: Extract<Awaited<ReturnType<typeof checkTCPHello>>, { ok: true }> | null =
    null;

  let serverPeer: ServerPeer | null = null;
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

  const lifecycle = createActor(machine).start();

  const identity: ConnectionIdentity = {
    principal: null,
    callerSession: null,
    peerSession,
    helloClient: 'unknown client',
  };

  const connectionView = createConnectionView(ctx);
  const queue = createOutboundQueue(peer, ctx.queueBytes);

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

  const canSeeOutput = (sessionID: SessionID): boolean =>
    connectionAccess === null || ctx.canSeeSession(sessionID, connectionAccess);

  const isUnauthenticatedTCP = (): boolean => tcp !== null && fingerprint === null;

  const buildGrantedView = (bridge: BridgeGrant): TargetAccess =>
    buildGrantedEventAccess(bridge.holder, ctx.findHeldAtcAccess(bridge.holder), (id) =>
      ctx.collectSubtree(bridge.holder).has(id),
    );

  const setPrincipal = (principal: string, viewer: string | null): void => {
    const entry = ctx.buildTargetAccess(principal);
    const access = viewer === null ? entry : entry.merge(ctx.buildTargetAccess(viewer));

    identity.principal = principal;
    connectionAccess = access;

    connectionView.startView(access);
  };

  const waitForDrain = async (): Promise<void> => {
    if (queue.queuedBytes === 0 || isIn('closed')) {
      return;
    }

    const drained = Promise.withResolvers<void>();

    drainWaiters.push(drained.resolve);

    await drained.promise;
  };

  const sendPeerMessage = async (message: EncodedMessage): Promise<void> => {
    if (typeof message !== 'string' || !queue.send(`${message}\n`)) {
      stopConnection();

      return;
    }

    const isRefusal = isIn('refusing');

    await waitForDrain();

    if (isRefusal) {
      sendLifecycleEvent({ type: 'DRAINED' });
    }
  };

  const answerPeerHello = async (
    input: RequestParams<'daemon.hello'>,
  ): Promise<DaemonAnswer<'daemon.hello'>> => {
    const tcpHello = acceptedTCPHello;

    if (tcpHello === null) {
      if (input.protocol !== PROTOCOL_V) {
        throw new AtcError(
          'protocol_mismatch',
          `${input.client} speaks protocol v${input.protocol ?? 'unknown'}, daemon ${ctx.build} speaks v${PROTOCOL_V}; restart the daemon so both run the same build`,
          { daemonProtocol: PROTOCOL_V, daemonMajor: CONTRACT_MAJOR },
        );
      }

      if (grant !== null && input.principal !== undefined) {
        throw new AtcError('unauthorized', "a session's atc access acts as no principal");
      }

      if (input.viewer !== undefined && input.principal === undefined) {
        throw new AtcError('bad_args', 'daemon.hello viewer needs a principal');
      }

      identity.callerSession = resolveCallerSession(identity.peerSession, input.session ?? null);
      identity.helloClient = input.client;

      if (input.principal !== undefined) {
        setPrincipal(input.principal, input.viewer ?? null);
      }
    } else {
      if (tcpHello.principal !== null) {
        setPrincipal(tcpHello.principal, tcpHello.viewer);
      }

      identity.callerSession = tcpHello.session;
      identity.helloClient = tcpHello.client;
      fingerprint = tcpHello.fingerprint;
    }

    const answer = await loadHelloAnswer(ctx, identity.peerSession);

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

  const checkPeerHello = async (request: StandardRequest): Promise<ProcedureContext | AtcError> => {
    const raw = decodePeerInput(request);

    if (tcp === null) {
      const refusal = checkHelloMajor(raw, ctx.build);

      if (refusal !== null) {
        return new AtcError(refusal.code, refusal.message, refusal.data);
      }
    } else {
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
        return new AtcError(hello.code, hello.message, hello.data);
      }

      acceptedTCPHello = hello;
    }

    return buildProcedureContext(ctx, null);
  };

  const checkPeerRequest = async (
    method: string,
    request: StandardRequest,
  ): Promise<ProcedureContext | AtcError> => {
    if (isIn('awaiting')) {
      sendLifecycleEvent({ type: 'REFUSE' });

      return new AtcError('unauthorized', 'daemon.hello must be the first request');
    }

    await waitFor(lifecycle, (snapshot) => !snapshot.matches('checking'));

    if (isIn('refusing')) {
      return new AtcError('unauthorized', 'the handshake was refused');
    }

    if (!isIn('open')) {
      return new AtcError('unauthorized', 'the connection is closing');
    }

    try {
      const as = parseRequestPrincipal(request.headers);

      if (grant !== null) {
        return buildProcedureContext(
          requireGrantedRequestContext({ ctx, connectionAccess, bridge: grant }, method, as),
          null,
        );
      }

      if (tcp !== null && method === 'events.subscribe' && as === null) {
        const access = connectionAccess ?? buildTargetAccessFromGrants([]);
        const eventsCtx = buildScopedContext(ctx, access, 'client:events');

        return buildProcedureContext(eventsCtx, null);
      }

      if (tcp !== null) {
        return buildProcedureContext(
          requireTCPRequestContext(
            { ctx, tcp, principal: identity.principal, access: connectionAccess },
            method,
            as,
          ),
          as,
        );
      }

      const scope = findRequestScope(ctx, identity.principal, connectionAccess, as?.principal);

      if (scope !== null && isOwnerOnlyMethod(method)) {
        return new AtcError('unauthorized', `${method} is open to the daemon's owner only`);
      }

      const requestCtx =
        scope === null ? ctx : buildScopedContext(ctx, scope.access, scope.keyNamespace);

      return buildProcedureContext(requestCtx, as);
    } catch (error) {
      if (error instanceof AtcError) {
        return error;
      }

      throw error;
    }
  };

  const answerPeerHandshake = async (request: StandardRequest): Promise<StandardResponse> => {
    if (!isIn('awaiting')) {
      return answerPeerRequest(
        request,
        new AtcError('unauthorized', 'a connection takes one handshake'),
      );
    }

    sendLifecycleEvent({ type: 'HELLO' });

    const admitted = await checkPeerHello(request);
    const response = await answerPeerRequest(request, admitted);

    if (isIn('checking')) {
      sendLifecycleEvent({ type: 'REFUSE' });
    }

    return response;
  };

  const answerPeer = async (request: StandardRequest): Promise<StandardResponse> => {
    const method = toPeerMethod(request.url.pathname);

    if (method === null) {
      if (isIn('awaiting')) {
        sendLifecycleEvent({ type: 'REFUSE' });
      }

      return answerPeerRequest(
        request,
        new AtcError('unknown_method', `unknown method '${request.url.pathname}'`),
      );
    }

    if (method === 'daemon.hello') {
      return answerPeerHandshake(request);
    }

    const admitted = await checkPeerRequest(method, request);

    return answerPeerRequest(request, admitted);
  };

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
    const isAwaited = findPeerMethod(line) !== 'events.subscribe';

    if (isAwaited) {
      inFlight += 1;
    }

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

      for (const id of view.withdrawn) {
        feed.forgetSession(id);
      }

      for (const visible of view.events) {
        feed.emit(visible);
      }

      // Detaching a session emits an event of its own, so it must run after the view has settled.
      for (const id of view.withdrawn) {
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

  if (tcp !== null) {
    connectionAccess = buildTargetAccessFromGrants([]);
  }

  if (grant !== null) {
    connectionAccess = buildGrantedView(grant);

    connectionView.startView(connectionAccess);
  }

  return self;
}
