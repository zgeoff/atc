import { createHash, randomBytes } from 'node:crypto';
import type { Clock } from '@atc/core';
import { EVENTS_PAGE_SCHEMA } from '@atc/protocol';
import type { Kysely } from 'kysely';
import invariant from 'tiny-invariant';
import { createActor } from 'xstate';
import type { Actor } from 'xstate';
import type { MCPAuthSchema } from '../auth/mcp-auth-schema';
import { normalizeClientName } from '../auth/normalize-client-name';
import { readClientName } from '../auth/read-client-name';
import type { FleetCaller } from '../tools/types';
import { buildWebhookRequest } from './build-webhook-request';
import { createSubscriptionStore } from './create-subscription-store';
import type { SubscriptionRow, SubscriptionStore } from './create-subscription-store';
import { createSubscriptionWatcherMachine } from './create-subscription-watcher-machine';
import type { PageDelivery, TrailPage } from './create-subscription-watcher-machine';
import { EVENT_TYPES } from './event-types';
import { parseWebhookSecret } from './parse-webhook-secret';
import type { WebhookOutcome, WebhookSender } from './types';

interface EventDelivererDeps {
  readonly db: Kysely<MCPAuthSchema>;
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
  readonly stop: () => void;
}

interface DelivererContext extends EventDelivererDeps {
  readonly subscriptions: SubscriptionStore;
}

// Each subscription's watcher reads the trail as the subscription's client,
// so it sees only the sessions the client's principal reaches, and it stores
// how far it got, so a restarted server resumes where it stopped.
export function createEventDeliverer(options: EventDelivererDeps): EventDeliverer {
  const deps: DelivererContext = { ...options, subscriptions: createSubscriptionStore(options.db) };

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

  // xstate's clock takes a timer id, and the server's clock hands back a cancel
  const cancels = new Map<number, () => void>();

  let nextTimerID = 0;

  const clock = {
    setTimeout: (fn: () => void, timeout: number) => {
      const timerID = nextTimerID++;

      cancels.set(
        timerID,
        deps.clock.schedule(() => {
          cancels.delete(timerID);

          fn();
        }, timeout),
      );

      return timerID;
    },
    clearTimeout: (timerID: number) => {
      cancels.get(timerID)?.();
      cancels.delete(timerID);
    },
  };

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
        watchers.delete(subscriptionID);
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
  deps: DelivererContext,
  subscriptionID: string,
): Promise<SubscriptionRow | null> {
  const now = deps.clock.now();

  const stored = await deps.subscriptions.read(subscriptionID, now);

  if (stored === null || stored.state === 'live') {
    return stored?.row ?? null;
  }

  // A refresh that lands between the read and the removal renews the row,
  // and the removal then leaves it, so the watcher reads the renewed row.
  const removed = await deps.subscriptions.expire(subscriptionID, stored.row.refresh_before, now);

  return removed ? null : readLiveSubscription(deps, subscriptionID);
}

// How long a read of the trail waits for an event, the most the daemon allows.
const READ_WAIT_MS = 30_000;
const READ_LIMIT = 50;

async function readTrailPage(deps: DelivererContext, row: SubscriptionRow): Promise<TrailPage> {
  const storedName = await readClientName(deps.db, row.client_id);

  const answer = await deps.caller.sendRequest(
    'events.read',
    { cursor: row.position, waitMs: READ_WAIT_MS, limit: READ_LIMIT },
    { id: row.client_id, name: normalizeClientName(storedName, 'remote') },
  );

  const parsed = EVENTS_PAGE_SCHEMA.safeParse(answer);

  if (!parsed.success) {
    throw new Error(`the daemon answered with no page: ${parsed.error.message}`);
  }

  return parsed.data;
}

async function deliverPage(deps: DelivererContext, delivery: PageDelivery): Promise<void> {
  for (const event of delivery.page.events) {
    // The row is read again for each event, so a refresh's new secret signs
    // the next delivery and a removed subscription gets none.
    const row = await readLiveSubscription(deps, delivery.subscriptionID);

    if (row === null || delivery.signal.aborted) {
      return;
    }

    // A client that lost read gets no delivery, and the position stays before
    // the event, so the watcher's next turn decides whether access is gone.
    const reads = await deps.probeAccess(row.client_id);

    if (!reads) {
      return;
    }

    const type = EVENT_TYPES.find((candidate) => candidate.name === row.name);

    if (type?.kind === event.kind) {
      await deliverEvent(deps, row, event);
    }

    await writePosition(deps, delivery.subscriptionID, event.cursor);
  }

  if (!delivery.signal.aborted) {
    await writePosition(deps, delivery.subscriptionID, delivery.page.cursor);
  }
}

async function deliverEvent(
  deps: DelivererContext,
  row: SubscriptionRow,
  event: TrailPage['events'][number],
): Promise<void> {
  const secret = parseWebhookSecret(row.secret);

  invariant(secret, 'a stored subscription holds a secret its subscribe refused');

  const digest = createHash('sha256').update(formatEventSource(event)).digest('hex');

  // The event's cursor points past the event, so a subscriber that reads the
  // trail from it starts after this event.
  const body = JSON.stringify({
    eventId: `evt_${digest.slice(0, 32)}`,
    name: row.name,
    timestamp: new Date(event.at).toISOString(),
    data: { session: event.session },
    cursor: event.cursor,
  });

  const request = buildWebhookRequest({
    url: row.url,
    subscriptionID: row.id,
    webhookID: `msg_${randomBytes(16).toString('base64url')}`,
    secrets: [secret],
    timestamp: Math.floor(deps.clock.now() / 1000),
    body,
  });

  const outcome = await deps.send(request);

  if (!isAcknowledged(outcome)) {
    deps.log(`atc events: delivery of ${row.name} to ${row.id} failed: ${formatOutcome(outcome)}`);
  }
}

// A gateway's merged cursor changes when another daemon's place moves, so an
// event a gateway merged takes its identity from the daemon that wrote it.
function formatEventSource(event: TrailPage['events'][number]): string {
  return event.origin === undefined
    ? event.cursor
    : `${event.origin.daemon}.${event.origin.incarnation}.${event.origin.cursor}`;
}

function isAcknowledged(outcome: WebhookOutcome): boolean {
  return outcome.kind === 'answered' && outcome.status >= 200 && outcome.status <= 299;
}

function formatOutcome(outcome: WebhookOutcome): string {
  return outcome.kind === 'failed' ? outcome.reason : `HTTP ${outcome.status}`;
}

async function writePosition(
  deps: DelivererContext,
  subscriptionID: string,
  position: string,
): Promise<void> {
  await deps.subscriptions.advance(subscriptionID, position, deps.clock.now());
}
