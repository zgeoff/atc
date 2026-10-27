import { createHash, timingSafeEqual } from 'node:crypto';
import { DaemonError } from '@atc/protocol/wire';
import type { DaemonEvent } from '@atcx/contract';
import { SESSION_DESCRIPTOR_SCHEMA } from '@atcx/contract';
import { z } from 'zod';
import type { HTTPServerContext, Requester, SecurityEvent } from '../auth/types';
import { createPTYViewer } from './create-pty-viewer';
import type { PTYSnapshot, PTYViewer, WatchChannel } from './create-pty-viewer';
import { parsePTYProtocols } from './parse-pty-protocols';
import { verifyAccessToken } from './verify-access-token';
import { WATCH_ANSWER_SCHEMA } from './watch-answer-schema';

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

type RefusalOutcome =
  | { readonly kind: 'authorize_invalid'; readonly reason: 'bad_host' | 'bad_origin' }
  | { readonly kind: 'bearer'; readonly reason: 'malformed' | 'invalid_token' };

// Every refusal comes before the upgrade, so a browser that may not watch
// the session never gets a socket. A session the caller cannot see answers
// 404, as one that does not exist does.
export async function answerPTYRequest(
  route: PTYRoute,
  ctx: HTTPServerContext | null,
  pty: PTYRequest,
): Promise<Response | undefined> {
  const request = pty.request;
  const host = request.headers.get('host');

  const refuse = (status: number, outcome: RefusalOutcome): Response => {
    route.security.record({
      ...outcome,
      outcome: 'rejected',
      path: new URL(request.url).pathname,
      requester: route.readRequester(request),
    });

    return new Response(null, { status });
  };

  if (host === null || !route.hosts.has(host)) {
    return refuse(403, { kind: 'authorize_invalid', reason: 'bad_host' });
  }

  if (ctx === null) {
    return new Response(null, { status: 503 });
  }

  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
    return new Response(null, { status: 426, headers: { upgrade: 'websocket' } });
  }

  // A request with no Origin header comes from no browser page, so only the
  // bearer token gates it.
  const origin = request.headers.get('origin');

  if (origin !== null && !route.allowedOrigins.has(origin)) {
    return refuse(403, { kind: 'authorize_invalid', reason: 'bad_origin' });
  }

  const protocols = parsePTYProtocols(request.headers.get('sec-websocket-protocol'));

  if (!protocols.ok && protocols.reason === 'no_protocol') {
    return new Response(null, { status: 400 });
  }

  if (!protocols.ok) {
    return refuse(401, { kind: 'bearer', reason: 'malformed' });
  }

  const principal = await resolvePrincipal(route, ctx, protocols.token);

  if (principal === 'refused') {
    return refuse(401, { kind: 'bearer', reason: 'invalid_token' });
  }

  if (principal === 'no_read') {
    return new Response(null, { status: 403 });
  }

  let channel: WatchChannel;

  try {
    channel = await route.openWatchChannel(principal);
  } catch {
    return new Response(null, { status: 503 });
  }

  // Output the daemon sends while the snapshot is read reaches the viewer
  // once it exists.
  const early: DaemonEvent[] = [];

  channel.onEvent = (event) => {
    early.push(event);
  };

  const snapshot = await readSnapshot(channel, pty.sessionID);

  if (typeof snapshot === 'number') {
    channel.stop();

    return new Response(null, { status: snapshot });
  }

  const viewer = createPTYViewer({
    sessionID: pty.sessionID,
    channel,
    first: snapshot,
    maxBufferedBytes: route.maxBufferedBytes,
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

// A token from the owner's token file acts as the owner; any other is an
// OAuth access token, which needs the read scope to watch.
async function resolvePrincipal(
  route: PTYRoute,
  ctx: HTTPServerContext,
  token: string,
): Promise<string | null | 'refused' | 'no_read'> {
  if (route.ownerTokens.some((ownerToken) => isSameToken(ownerToken, token))) {
    return null;
  }

  const access = await verifyAccessToken(ctx, token);

  if (access === null) {
    return 'refused';
  }

  return access.scopes.includes('read') ? access.clientID : 'no_read';
}

// The digests have one length, so the comparison takes the same time
// whatever the presented token holds.
function isSameToken(expected: string, presented: string): boolean {
  const expectedDigest = createHash('sha256').update(expected).digest();
  const presentedDigest = createHash('sha256').update(presented).digest();

  return timingSafeEqual(expectedDigest, presentedDigest);
}

const GET_ANSWER_SCHEMA = z.object({
  session: SESSION_DESCRIPTOR_SCHEMA.pick({ state: true }),
});

// The snapshot, or the status a refusal answers with.
async function readSnapshot(
  channel: WatchChannel,
  sessionID: string,
): Promise<PTYSnapshot | number> {
  try {
    const got = await channel.sendRequest('session.get', { session: sessionID });
    const watched = await channel.sendRequest('session.watch', { session: sessionID });

    const state = GET_ANSWER_SCHEMA.parse(got).session.state;

    return { ...WATCH_ANSWER_SCHEMA.parse(watched), state };
  } catch (error) {
    if (error instanceof DaemonError && error.code === 'no_such_session') {
      return 404;
    }

    if (error instanceof DaemonError && error.code === 'session_dead') {
      return 409;
    }

    return 503;
  }
}
