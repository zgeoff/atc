import { createHash, randomBytes } from 'node:crypto';
import type { Clock } from '@atc/core';
import type { Kysely } from 'kysely';
import invariant from 'tiny-invariant';
import { z } from 'zod';
import type { MCPAuthSchema } from '../auth/mcp-auth-schema';
import { normalizeClientName } from '../auth/normalize-client-name';
import { readClientName } from '../auth/read-client-name';
import type { FleetCaller } from '../tools/types';
import { buildWebhookRequest } from './build-webhook-request';
import { EVENT_TYPES } from './event-types';
import { parseWebhookSecret } from './parse-webhook-secret';
import type { WebhookOutcome, WebhookSender } from './types';

interface EventDelivererDeps {
  readonly db: Kysely<MCPAuthSchema>;
  readonly caller: FleetCaller;
  readonly send: WebhookSender;
  readonly clock: Clock;

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

interface DelivererState {
  stopped: boolean;
}

// How long a watcher waits after a read the daemon could not answer.
const READ_RETRY_MS = 5000;

// Each subscription's watcher reads the trail as the subscription's client,
// so it sees only the sessions the client's principal reaches, and it stores
// how far it got, so a restarted server resumes where it stopped.
export function createEventDeliverer(deps: EventDelivererDeps): EventDeliverer {
  const watching = new Set<string>();
  const pendingWaits = new Set<() => void>();

  const state: DelivererState = { stopped: false };

  const wait = (delayMs: number) => {
    const resolvers = Promise.withResolvers<void>();

    const finish = () => {
      pendingWaits.delete(finish);

      cancel();

      resolvers.resolve();
    };

    const cancel = deps.clock.schedule(finish, delayMs);

    pendingWaits.add(finish);

    return resolvers.promise;
  };

  const runWatcher = async (subscriptionID: string) => {
    for (;;) {
      const row = await readLiveSubscription(deps, subscriptionID);

      if (row === null || state.stopped) {
        return;
      }

      const page = await tryReadPage(deps, row);

      if (state.stopped) {
        return;
      }

      await (page === null
        ? wait(READ_RETRY_MS)
        : deliverPage(deps, { subscriptionID, page, state }));
    }
  };

  // A watcher's store closes with the server, so a failure after a stop is
  // part of shutting down.
  const runGuardedWatcher = async (subscriptionID: string) => {
    try {
      await runWatcher(subscriptionID);
    } catch (error) {
      if (!state.stopped) {
        deps.log(`atc events: the watcher of ${subscriptionID} stopped: ${String(error)}`);
      }
    }

    watching.delete(subscriptionID);

    // A subscribe that stored the row again while this watcher was ending
    // found it still registered, so its watch started nothing.
    const renewed = state.stopped ? undefined : await tryReadRowID(deps, subscriptionID);

    if (renewed !== undefined) {
      watch(subscriptionID);
    }
  };

  const watch = (subscriptionID: string) => {
    if (state.stopped || watching.has(subscriptionID)) {
      return;
    }

    watching.add(subscriptionID);
    void runGuardedWatcher(subscriptionID);
  };

  return {
    start: async () => {
      const rows = await deps.db.selectFrom('atc_event_subscription').select('id').execute();

      for (const row of rows) {
        watch(row.id);
      }
    },
    watch,
    stop: () => {
      state.stopped = true;

      for (const finish of pendingWaits) {
        finish();
      }
    },
  };
}

type SubscriptionRow = MCPAuthSchema['atc_event_subscription'];

// A subscription past its refreshBefore is gone, as the extension says, so the
// watcher removes its row and ends.
async function readLiveSubscription(
  deps: EventDelivererDeps,
  subscriptionID: string,
): Promise<SubscriptionRow | null> {
  const row = await deps.db
    .selectFrom('atc_event_subscription')
    .selectAll()
    .where('id', '=', subscriptionID)
    .executeTakeFirst();

  if (row === undefined) {
    return null;
  }

  if (Date.parse(row.refresh_before) > deps.clock.now()) {
    return row;
  }

  // A refresh that lands between the read and the delete renews the row, and
  // the delete then leaves it, so the watcher reads the renewed row.
  const removed = await deps.db
    .deleteFrom('atc_event_subscription')
    .where('id', '=', subscriptionID)
    .where('refresh_before', '=', row.refresh_before)
    .executeTakeFirst();

  return removed.numDeletedRows > 0n ? null : readLiveSubscription(deps, subscriptionID);
}

// How long a read of the trail waits for an event, the most the daemon allows.
const READ_WAIT_MS = 30_000;
const READ_LIMIT = 50;

// The part of an events.read answer a watcher reads.
const TRAIL_EVENT_SCHEMA = z.object({
  cursor: z.string(),
  at: z.number(),
  session: z.string(),
  kind: z.string(),
});

const PAGE_SCHEMA = z.object({ events: z.array(TRAIL_EVENT_SCHEMA), cursor: z.string() });

type TrailPage = z.infer<typeof PAGE_SCHEMA>;

async function tryReadPage(
  deps: EventDelivererDeps,
  row: SubscriptionRow,
): Promise<TrailPage | null> {
  const storedName = await readClientName(deps.db, row.client_id);

  try {
    const answer = await deps.caller.sendRequest(
      'events.read',
      { cursor: row.position, waitMs: READ_WAIT_MS, limit: READ_LIMIT },
      { id: row.client_id, name: normalizeClientName(storedName, 'remote') },
    );

    const parsed = PAGE_SCHEMA.safeParse(answer);

    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

interface PageDelivery {
  readonly subscriptionID: string;
  readonly page: TrailPage;
  readonly state: DelivererState;
}

async function deliverPage(deps: EventDelivererDeps, delivery: PageDelivery): Promise<void> {
  for (const event of delivery.page.events) {
    // The row is read again for each event, so a refresh's new secret signs
    // the next delivery and a removed subscription gets none.
    const row = await readLiveSubscription(deps, delivery.subscriptionID);

    if (row === null || delivery.state.stopped) {
      return;
    }

    const type = EVENT_TYPES.find((candidate) => candidate.name === row.name);

    if (type?.kind === event.kind) {
      await deliverEvent(deps, row, event);
    }

    await writePosition(deps, delivery.subscriptionID, event.cursor);
  }

  if (!delivery.state.stopped) {
    await writePosition(deps, delivery.subscriptionID, delivery.page.cursor);
  }
}

async function deliverEvent(
  deps: EventDelivererDeps,
  row: SubscriptionRow,
  event: z.infer<typeof TRAIL_EVENT_SCHEMA>,
): Promise<void> {
  const secret = parseWebhookSecret(row.secret);

  invariant(secret, 'a stored subscription holds a secret its subscribe refused');

  const digest = createHash('sha256').update(event.cursor).digest('hex');

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

function isAcknowledged(outcome: WebhookOutcome): boolean {
  return outcome.kind === 'answered' && outcome.status >= 200 && outcome.status <= 299;
}

function formatOutcome(outcome: WebhookOutcome): string {
  return outcome.kind === 'failed' ? outcome.reason : `HTTP ${outcome.status}`;
}

async function writePosition(
  deps: EventDelivererDeps,
  subscriptionID: string,
  position: string,
): Promise<void> {
  await deps.db
    .updateTable('atc_event_subscription')
    .set({ position })
    .where('id', '=', subscriptionID)
    .execute();
}

// The store closes with the server, and a watcher can end after it closed.
async function tryReadRowID(
  deps: EventDelivererDeps,
  subscriptionID: string,
): Promise<string | undefined> {
  try {
    const row = await deps.db
      .selectFrom('atc_event_subscription')
      .select('id')
      .where('id', '=', subscriptionID)
      .executeTakeFirst();

    return row?.id;
  } catch {
    return undefined;
  }
}
