import type { Clock } from '@atc/core';
import { DaemonError } from '@atc/protocol/wire';
import { ProtocolError } from '@modelcontextprotocol/server';
import type { Kysely } from 'kysely';
import invariant from 'tiny-invariant';
import type { z } from 'zod';
import type { MCPAuthSchema } from '../auth/mcp-auth-schema';
import type { FleetCaller } from '../tools/types';
import { buildSubscriptionID } from './build-subscription-id';
import type { EventDeliverer } from './create-event-deliverer';
import { EVENT_ERROR_CODES } from './event-error-codes';
import { parseSubscribeRequest } from './parse-subscribe-request';
import type { SUBSCRIBE_PARAMS, SubscribeRequest } from './parse-subscribe-request';
import type { WebhookSender } from './types';
import { verifyCallback } from './verify-callback';

export interface EventMethodDeps {
  readonly db: Kysely<MCPAuthSchema>;

  // Acts as the subscribing client.
  readonly caller: FleetCaller;
  readonly clientID: string;
  readonly send: WebhookSender;
  readonly clock: Clock;
  readonly deliverer: EventDeliverer;
}

interface SubscribeResult {
  readonly id: string;
  readonly refreshBefore: string;
  readonly cursor: string;
  readonly truncated: boolean;
}

export async function answerSubscribeRequest(
  deps: EventMethodDeps,
  params: z.infer<typeof SUBSCRIBE_PARAMS>,
): Promise<SubscribeResult & Readonly<Record<string, unknown>>> {
  const parsed = parseSubscribeRequest(params);

  if (!parsed.ok) {
    throw new ProtocolError(parsed.refusal.code, parsed.refusal.message, parsed.refusal.data);
  }

  const request = parsed.request;
  const now = deps.clock.now();

  const id = buildSubscriptionID({
    clientID: deps.clientID,
    url: request.url,
    name: request.type.name,
    arguments: '{}',
  });

  await requireVerifiedCallback(deps, request, id);

  const existing = await deps.db
    .selectFrom('atc_event_subscription')
    .select(['position', 'refresh_before'])
    .where('id', '=', id)
    .executeTakeFirst();

  // A row past its refreshBefore that the watcher has yet to remove is gone,
  // so the subscribe starts afresh from the client's cursor.
  const position =
    existing !== undefined && Date.parse(existing.refresh_before) > now
      ? existing.position
      : await readStartPosition(deps, request.cursor);

  const refreshBefore = new Date(now + pickTTL(request.ttlMs)).toISOString();

  await deps.db
    .insertInto('atc_event_subscription')
    .values({
      id,
      client_id: deps.clientID,
      url: request.url,
      name: request.type.name,
      arguments: '{}',
      secret: request.secret,
      position,
      refresh_before: refreshBefore,
      created_at: new Date(now).toISOString(),
    })
    .onConflict((conflict) =>
      conflict
        .column('id')
        .doUpdateSet({ secret: request.secret, position, refresh_before: refreshBefore }),
    )
    .execute();

  deps.deliverer.watch(id);

  return { id, refreshBefore, cursor: position, truncated: false };
}

// How long one echoed challenge covers a client's callback URL.
const VERIFIED_FOR_MS = 7 * 24 * 60 * 60 * 1000;

async function requireVerifiedCallback(
  deps: EventMethodDeps,
  request: SubscribeRequest,
  subscriptionID: string,
): Promise<void> {
  const now = deps.clock.now();

  const verified = await deps.db
    .selectFrom('atc_event_callback')
    .select('verified_at')
    .where('client_id', '=', deps.clientID)
    .where('url', '=', request.url)
    .executeTakeFirst();

  if (verified !== undefined && Date.parse(verified.verified_at) + VERIFIED_FOR_MS > now) {
    return;
  }

  const verdict = await verifyCallback({
    send: deps.send,
    url: request.url,
    subscriptionID,
    secret: request.secretBytes,
    timestamp: Math.floor(now / 1000),
  });

  if (!verdict.verified) {
    throw new ProtocolError(
      EVENT_ERROR_CODES.callbackEndpoint,
      'the callback endpoint did not echo the verification challenge',
      { reason: verdict.reason },
    );
  }

  const verifiedAt = new Date(now).toISOString();

  await deps.db
    .insertInto('atc_event_callback')
    .values({ client_id: deps.clientID, url: request.url, verified_at: verifiedAt })
    .onConflict((conflict) =>
      conflict.columns(['client_id', 'url']).doUpdateSet({ verified_at: verifiedAt }),
    )
    .execute();
}

// A client's cursor starts delivery after the event it points past, so the
// events it missed while it held no subscription arrive. No cursor starts
// after the newest event.
async function readStartPosition(deps: EventMethodDeps, cursor: string | null): Promise<string> {
  let page: Readonly<Record<string, unknown>>;

  try {
    page = await deps.caller.sendRequest('events.read', {
      ...(cursor === null ? {} : { cursor }),
      limit: 1,
    });
  } catch (error) {
    if (cursor !== null && error instanceof DaemonError && error.code === 'bad_args') {
      throw new ProtocolError(EVENT_ERROR_CODES.invalidParams, 'atc does not take that cursor');
    }

    throw error;
  }

  const start = cursor ?? page['cursor'];

  invariant(typeof start === 'string', 'the event trail answered without a cursor');

  return start;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_TTL_MS = 7 * DEFAULT_TTL_MS;

// The shortest lifetime granted, so a client cannot make atc refresh it in a loop.
const MIN_TTL_MS = 60 * 1000;

// A request for no expiry gets the longest lifetime instead, so a client that
// stops refreshing loses its subscription in the end.
function pickTTL(ttlMs: number | null | undefined): number {
  if (ttlMs === undefined) {
    return DEFAULT_TTL_MS;
  }

  if (ttlMs === null) {
    return MAX_TTL_MS;
  }

  return Math.min(Math.max(ttlMs, MIN_TTL_MS), MAX_TTL_MS);
}
