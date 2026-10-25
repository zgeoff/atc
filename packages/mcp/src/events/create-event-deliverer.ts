import { createHash } from 'node:crypto';
import { toTimerClock } from '@atc/core';
import type { Clock } from '@atc/core';
import { EVENTS_PAGE_SCHEMA } from '@atcx/contract';
import type { Kysely } from 'kysely';
import invariant from 'tiny-invariant';
import { createActor } from 'xstate';
import type { Actor } from 'xstate';
import { z } from 'zod';
import type { MCPAuthSchema } from '../auth/mcp-auth-schema';
import { normalizeClientName } from '../auth/normalize-client-name';
import { readClientName } from '../auth/read-client-name';
import type { FleetCaller } from '../tools/types';
import { buildWebhookRequest } from './build-webhook-request';
import type { SubscriptionRow, SubscriptionStore } from './create-subscription-store';
import { createSubscriptionWatcherMachine } from './create-subscription-watcher-machine';
import type { PageDelivery, TrailPage } from './create-subscription-watcher-machine';
import { EVENT_TYPES } from './event-types';
import { parseWebhookSecret } from './parse-webhook-secret';
import { pickAccessStep } from './pick-access-step';
import { pickDeliveryStep } from './pick-delivery-step';
import { pickEventStep } from './pick-event-step';
import type { WebhookOutcome, WebhookRequest, WebhookSender } from './types';

interface EventDelivererDeps {
  readonly db: Kysely<MCPAuthSchema>;
  readonly subscriptions: SubscriptionStore;
  readonly caller: FleetCaller;
  readonly send: WebhookSender;
  readonly clock: Clock;

  // Answers whether the client still holds a live grant with read.
  readonly probeAccess: (clientID: string) => Promise<boolean>;

  // Receives one line per delivery that failed.
  readonly log: (line: string) => void;
}

export interface EventDeliverer {
  // Starts a watcher for each stored subscription.
  readonly start: () => Promise<void>;

  // Starts a watcher for the subscription, unless one runs for it.
  readonly watch: (subscriptionID: string) => void;

  // Ends the subscription's watcher, so work it started before an
  // unsubscribe never acts on a subscription stored again with the same id.
  readonly retire: (subscriptionID: string) => void;
  readonly stop: () => void;
}

// Each subscription's watcher reads the trail as the subscription's client,
// so it sees only the sessions the client's principal reaches, and it stores
// how far it got, so a restarted server resumes where it stopped.
export function createEventDeliverer(deps: EventDelivererDeps): EventDeliverer {
  const machine = createSubscriptionWatcherMachine({
    readSubscription: (subscriptionID) => readLiveSubscription(deps, subscriptionID),
    probeAccess: deps.probeAccess,
    readTrail: (row) => readTrailPage(deps, row),
    deliverPage: (delivery) => deliverPage(deps, delivery),
    endSubscription: async (subscriptionID) => {
      await deps.subscriptions.end(subscriptionID);
    },
    log: deps.log,
  });

  const watchers = new Map<string, Actor<typeof machine>>();

  const state = { stopped: false };
  const clock = toTimerClock(deps.clock);

  const watch = (subscriptionID: string) => {
    if (state.stopped) {
      return;
    }

    const running = watchers.get(subscriptionID);

    if (running !== undefined) {
      running.send({ type: 'WATCH' });

      return;
    }

    const actor = createActor(machine, { clock, input: { subscriptionID } });

    actor.subscribe({
      complete: () => {
        if (watchers.get(subscriptionID) === actor) {
          watchers.delete(subscriptionID);
        }
      },
    });

    watchers.set(subscriptionID, actor);
    actor.start();
  };

  return {
    start: async () => {
      const subscriptionIDs = await deps.subscriptions.readIDs();

      for (const subscriptionID of subscriptionIDs) {
        watch(subscriptionID);
      }
    },
    watch,
    retire: (subscriptionID) => {
      watchers.get(subscriptionID)?.stop();
      watchers.delete(subscriptionID);
    },
    stop: () => {
      state.stopped = true;

      for (const actor of watchers.values()) {
        actor.stop();
      }

      watchers.clear();
    },
  };
}

// A subscription past its refreshBefore is gone, as the extension says, so the
// watcher removes its row and ends.
async function readLiveSubscription(
  deps: EventDelivererDeps,
  subscriptionID: string,
): Promise<SubscriptionRow | null> {
  const now = deps.clock.now();

  const stored = await deps.subscriptions.read(subscriptionID, now);

  if (stored === null || stored.state === 'live') {
    return stored?.row ?? null;
  }

  // A refresh that lands between the read and the removal renews the row,
  // and the removal then leaves it, so the watcher reads the renewed row.
  const removed = await deps.subscriptions.expire(subscriptionID, now);

  return removed ? null : readLiveSubscription(deps, subscriptionID);
}

// How long a read of the trail waits for an event, the most the daemon allows.
const READ_WAIT_MS = 30_000;
const READ_LIMIT = 50;

// A gateway's page lists the daemons that did not answer the read.
const GATEWAY_PAGE_SCHEMA = EVENTS_PAGE_SCHEMA.extend({
  unavailable: z.array(z.string()).optional(),
});

async function readTrailPage(deps: EventDelivererDeps, row: SubscriptionRow): Promise<TrailPage> {
  const storedName = await readClientName(deps.db, row.client_id);

  const answer = await deps.caller.sendRequest(
    'events.read',
    { cursor: row.position, waitMs: READ_WAIT_MS, limit: READ_LIMIT },
    { id: row.client_id, name: normalizeClientName(storedName, 'remote') },
  );

  const parsed = GATEWAY_PAGE_SCHEMA.safeParse(answer);

  if (!parsed.success) {
    throw new Error(`the daemon answered with no page: ${parsed.error.message}`);
  }

  const unavailable = parsed.data.unavailable ?? [];

  // A gateway skips its wait when no daemon it reaches can wait, so a page
  // with no event from an outage reads as a failure, which the watcher logs
  // and waits out before it reads again.
  if (parsed.data.events.length === 0 && unavailable.length > 0) {
    throw new Error(`the gateway could not reach ${unavailable.join(', ')}`);
  }

  return parsed.data;
}

async function deliverPage(deps: EventDelivererDeps, delivery: PageDelivery): Promise<void> {
  for (const event of delivery.page.events) {
    const row = await readLiveSubscription(deps, delivery.subscriptionID);

    const isStopped = delivery.signal.aborted;
    const reads = row === null || isStopped ? false : await deps.probeAccess(row.client_id);
    const type = EVENT_TYPES.find((candidate) => candidate.name === row?.name);

    const step = pickEventStep({
      isGone: row === null,
      isStopped,
      reads,
      isMatch: type?.kind === event.kind,
    });

    if (step.kind === 'stop') {
      return;
    }

    const settled = step.kind === 'deliver' ? await deliverEvent(deps, delivery, event) : true;

    // A delivery that a stop or a lost grant cut short leaves the position
    // before the event, so a restarted server or the watcher's next turn
    // decides it again.
    if (!settled || delivery.signal.aborted) {
      return;
    }

    await writePosition(deps, delivery.subscriptionID, event.cursor);
  }

  if (!delivery.signal.aborted) {
    await writePosition(deps, delivery.subscriptionID, delivery.page.cursor);
  }
}

// The authorization server rotates a refresh token by revoking it and then
// storing its successor, in two writes, so a retry that finds no grant with
// read checks again after this wait before it gives the event up.
const ACCESS_RECHECK_MS = 5000;

async function deliverEvent(
  deps: EventDelivererDeps,
  delivery: PageDelivery,
  event: TrailPage['events'][number],
): Promise<boolean> {
  const source = formatEventSource(event);
  const digest = createHash('sha256').update(source).digest('hex');
  const delivered = createHash('sha256').update(`${delivery.subscriptionID}.${source}`);
  const webhookID = `msg_${delivered.digest('hex').slice(0, 32)}`;
  let attempt = 1;
  let isRechecking = false;

  for (;;) {
    // The row is read again before each attempt, so a refresh's new secret
    // signs it and a removed subscription gets none.
    const row = await readLiveSubscription(deps, delivery.subscriptionID);

    const isStopped = delivery.signal.aborted;
    const reads = row === null || isStopped ? false : await deps.probeAccess(row.client_id);
    const access = pickAccessStep({ isGone: row === null, reads, isStopped, isRechecking });

    if (access.kind === 'settle' || access.kind === 'cut') {
      return access.kind === 'settle';
    }

    isRechecking = access.kind === 'recheck';

    if (access.kind === 'recheck') {
      await waitOnClock(deps.clock, ACCESS_RECHECK_MS, delivery.signal);

      continue;
    }

    invariant(row, 'a delivery picked a send for a subscription that is gone');

    // The event's cursor points past the event, so a subscriber that reads the
    // trail from it starts after this event.
    const body = JSON.stringify({
      eventId: `evt_${digest.slice(0, 32)}`,
      name: row.name,
      timestamp: new Date(event.at).toISOString(),
      data: { session: event.session },
      cursor: event.cursor,
    });

    const outcome = await deps.send(buildSignedRequest(deps, { row, webhookID, body }));

    const step = pickDeliveryStep(outcome, attempt);

    if (step.kind === 'done') {
      return true;
    }

    deps.log(`atc events: delivery of ${row.name} to ${row.id} failed: ${formatOutcome(outcome)}`);

    if (step.kind === 'retry') {
      await waitOnClock(deps.clock, step.delayMs, delivery.signal);

      attempt += 1;
      continue;
    }

    if (step.kind === 'drop') {
      await removeSubscription(deps, row);

      return true;
    }

    deps.log(`atc events: gave up on delivering ${row.name} to ${row.id}`);

    return true;
  }
}

// Two daemons can hold events at one cursor, but each mints session ids at
// random; a gateway's merged cursor moves with other daemons, so its origin
// gives the daemon's own cursor.
function formatEventSource(event: TrailPage['events'][number]): string {
  return event.origin === undefined
    ? `${event.session}.${event.cursor}`
    : `${event.origin.daemon}.${event.origin.incarnation}.${event.origin.cursor}`;
}

// Ends early once the signal aborts, so a stopped watcher waits on nothing.
function waitOnClock(clock: Clock, delayMs: number, signal: AbortSignal): Promise<void> {
  const resolvers = Promise.withResolvers<void>();

  const finish = () => {
    cancel();

    signal.removeEventListener('abort', finish);
    resolvers.resolve();
  };

  const cancel = clock.schedule(finish, delayMs);

  signal.addEventListener('abort', finish, { once: true });

  return resolvers.promise;
}

interface SignedRequestParts {
  readonly row: SubscriptionRow;
  readonly webhookID: string;
  readonly body: string;
}

function buildSignedRequest(deps: EventDelivererDeps, parts: SignedRequestParts): WebhookRequest {
  const secret = parseWebhookSecret(parts.row.secret);

  invariant(secret, 'a stored subscription holds a secret its subscribe refused');

  return buildWebhookRequest({
    url: parts.row.url,
    subscriptionID: parts.row.id,
    webhookID: parts.webhookID,
    secrets: [secret],
    timestamp: Math.floor(deps.clock.now() / 1000),
    body: parts.body,
  });
}

function formatOutcome(outcome: WebhookOutcome): string {
  return outcome.kind === 'failed' ? outcome.reason : `HTTP ${outcome.status}`;
}

// A 410 ends the subscription, as the extension says. A subscribe that
// renewed the row after this attempt left it, and keeps it.
async function removeSubscription(deps: EventDelivererDeps, row: SubscriptionRow): Promise<void> {
  await deps.subscriptions.drop(row.id, row.refresh_before);

  deps.log(`atc events: removed ${row.id}, whose endpoint answered HTTP 410`);
}

async function writePosition(
  deps: EventDelivererDeps,
  subscriptionID: string,
  position: string,
): Promise<void> {
  await deps.subscriptions.advance(subscriptionID, position, deps.clock.now());
}
