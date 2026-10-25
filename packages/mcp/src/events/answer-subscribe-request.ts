import type { Clock } from '@atc/core';
import { DaemonError } from '@atc/protocol/wire';
import { EVENTS_PAGE_SCHEMA } from '@atcx/contract';
import { ProtocolError } from '@modelcontextprotocol/server';
import type { Kysely } from 'kysely';
import type { z } from 'zod';
import type { MCPAuthSchema } from '../auth/mcp-auth-schema';
import type { FleetCaller } from '../tools/types';
import { buildSubscriptionID } from './build-subscription-id';
import type { EventDeliverer } from './create-event-deliverer';
import { createSubscriptionStore } from './create-subscription-store';
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

  const store = createSubscriptionStore(deps.db);

  const existing = await store.read(id, now);

  const refreshBefore = new Date(now + pickTTL(request.ttlMs)).toISOString();

  if (existing?.state === 'live') {
    const refreshed = await store.refresh(
      id,
      { secret: request.secret, refresh_before: refreshBefore },
      now,
    );

    if (refreshed) {
      deps.deliverer.watch(id);

      return { id, refreshBefore, cursor: existing.row.position, truncated: false };
    }
  }

  // A subscription past its refreshBefore that the watcher has yet to remove
  // is gone, so the subscribe starts afresh from the client's cursor, and the
  // old watcher, whose pending read started from the old position, ends.
  const position = await readStartPosition(deps, request.cursor);

  deps.deliverer.retire(id);

  const started = await store.start(
    {
      id,
      client_id: deps.clientID,
      url: request.url,
      name: request.type.name,
      arguments: '{}',
      secret: request.secret,
      position,
      refresh_before: refreshBefore,
      created_at: new Date(now).toISOString(),
    },
    now,
  );

  // A subscribe of the same key that started the subscription meanwhile made
  // it live, so this one refreshes it instead.
  if (!started) {
    return answerSubscribeRequest(deps, params);
  }

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

// A client's cursor starts delivery after the event it points past, so the
// events it missed while it held no subscription arrive. No cursor starts
// after the newest event.
async function readStartPosition(deps: EventMethodDeps, cursor: string | null): Promise<string> {
  if (cursor === null) {
    return readHeadPosition(deps);
  }

  try {
    await deps.caller.sendRequest('events.read', { cursor, limit: 1 });
  } catch (error) {
    if (error instanceof DaemonError && error.code === 'bad_args') {
      throw new ProtocolError(EVENT_ERROR_CODES.invalidParams, 'atc does not take that cursor');
    }

    throw error;
  }

  return cursor;
}

const HEAD_PAGE_SCHEMA = EVENTS_PAGE_SCHEMA.pick({ cursor: true, more: true });

// The largest page a read returns.
const HEAD_READ_LIMIT = 200;

// A gateway answers a read without a cursor with each daemon's newest events
// merged into one page, and leaves the daemons whose events did not fit before
// them, so the read goes on until no daemon holds more.
async function readHeadPosition(deps: EventMethodDeps): Promise<string> {
  const first = await deps.caller.sendRequest('events.read', { limit: HEAD_READ_LIMIT });

  let page = HEAD_PAGE_SCHEMA.parse(first);

  while (page.more) {
    const next = await deps.caller.sendRequest('events.read', {
      cursor: page.cursor,
      limit: HEAD_READ_LIMIT,
    });

    page = HEAD_PAGE_SCHEMA.parse(next);
  }

  return page.cursor;
}
