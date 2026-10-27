import { createHash, timingSafeEqual } from 'node:crypto';
import type { DaemonEvent } from '@atcx/contract';
import invariant from 'tiny-invariant';
import type { HTTPServerContext, Requester, SecurityEvent } from '../auth/types';
import { probeReadAccess } from '../events/probe-read-access';
import { createPTYViewer } from './create-pty-viewer';
import type { PTYSnapshot, PTYViewer, WatchChannel } from './create-pty-viewer';
import { pickPTYAdmission } from './pick-pty-admission';
import type { PTYRefusalOutcome } from './pick-pty-admission';
import { pickPTYPrincipal } from './pick-pty-principal';
import { pickSnapshotStatus } from './pick-snapshot-status';
import { verifyAccessToken } from './verify-access-token';

// What the live-terminal route needs beyond the routes' context.
export interface PTYRoute {
  // The Host header values the server answers to.
  readonly hosts: ReadonlySet<string>;

  // The origins a browser page may open a live terminal from.
  readonly allowedOrigins: ReadonlySet<string>;

  // The tokens of the owner's token file, each of which acts as the
  // daemon's owner; empty without one.
  readonly ownerTokens: readonly string[];

  // How many bytes a viewer's socket may hold unsent before it drops output.
  readonly maxBufferedBytes: number;

  // How often a viewer that watches as an OAuth client checks that its
  // client may still read.
  readonly accessRecheckMs: number;

  // Opens a daemon connection of the viewer's own, handshaken as the
  // principal; null is the daemon's owner.
  readonly openWatchChannel: (principal: string | null) => Promise<WatchChannel>;
  readonly readRequester: (request: Request) => Requester;
  readonly security: { readonly record: (event: SecurityEvent) => void };
}

// One request for a session's live terminal, and the server's upgrade of it,
// which answers false when the request cannot become a WebSocket.
interface PTYRequest {
  readonly request: Request;
  readonly sessionID: string;
  readonly upgrade: (viewer: PTYViewer) => boolean;
}

// Every refusal comes before the upgrade, so a browser that may not watch
// the session never gets a socket.
export async function answerPTYRequest(
  route: PTYRoute,
  ctx: HTTPServerContext | null,
  pty: PTYRequest,
): Promise<Response | undefined> {
  const request = pty.request;

  const refuse = (status: number, outcome: PTYRefusalOutcome | null): Response => {
    if (outcome !== null) {
      route.security.record({
        ...outcome,
        outcome: 'rejected',
        path: new URL(request.url).pathname,
        requester: route.readRequester(request),
      });
    }

    return new Response(null, { status });
  };

  const admission = pickPTYAdmission(
    {
      host: request.headers.get('host'),
      upgrade: request.headers.get('upgrade'),
      origin: request.headers.get('origin'),
      protocols: request.headers.get('sec-websocket-protocol'),
      isServing: ctx !== null,
    },
    route,
  );

  if (admission.kind === 'refuse') {
    return refuse(admission.status, admission.outcome);
  }

  if (admission.kind === 'upgrade_required') {
    return new Response(null, { status: 426, headers: { upgrade: 'websocket' } });
  }

  invariant(ctx, 'an admission passed a request the server cannot serve yet');

  const token = admission.token;
  const isOwnerToken = route.ownerTokens.some((ownerToken) => isSameToken(ownerToken, token));
  const access = isOwnerToken ? null : await verifyAccessToken(ctx, token);
  const resolved = pickPTYPrincipal({ isOwnerToken, access });

  if (resolved.kind === 'refused') {
    return refuse(401, { kind: 'bearer', reason: 'invalid_token' });
  }

  if (resolved.kind === 'no_read') {
    return refuse(403, null);
  }

  let channel: WatchChannel;

  try {
    channel = await route.openWatchChannel(resolved.principal);
  } catch {
    return new Response(null, { status: 503 });
  }

  // Output the daemon sends while the snapshot is read reaches the viewer
  // once it exists.
  const early: DaemonEvent[] = [];

  channel.onEvent = (event) => {
    early.push(event);
  };

  let snapshot: PTYSnapshot;

  try {
    snapshot = await readSnapshot(channel, pty.sessionID);
  } catch (error) {
    channel.stop();

    return new Response(null, { status: pickSnapshotStatus(error) });
  }

  const clientID = resolved.principal;

  const viewer = createPTYViewer({
    sessionID: pty.sessionID,
    channel,
    first: snapshot,
    maxBufferedBytes: route.maxBufferedBytes,
    access:
      clientID === null
        ? null
        : {
            probe: () => probeReadAccess(ctx.store.db, clientID, ctx.clock.now()),
            clock: ctx.clock,
            recheckMs: route.accessRecheckMs,
          },
  });

  for (const event of early) {
    channel.onEvent(event);
  }

  if (!pty.upgrade(viewer)) {
    viewer.close();

    return new Response(null, { status: 400 });
  }

  return undefined;
}

// The digests have one length, so the comparison takes the same time
// whatever the presented token holds.
function isSameToken(expected: string, presented: string): boolean {
  const expectedDigest = createHash('sha256').update(expected).digest();
  const presentedDigest = createHash('sha256').update(presented).digest();

  return timingSafeEqual(expectedDigest, presentedDigest);
}

async function readSnapshot(channel: WatchChannel, sessionID: string): Promise<PTYSnapshot> {
  const got = await channel.procedures.session.get({ session: sessionID });
  const watched = await channel.procedures.session.watch({ session: sessionID });

  return { ...watched, state: got.session.state };
}
