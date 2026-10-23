import type { Kysely } from 'kysely';
import type { MCPAuthSchema } from '../auth/mcp-auth-schema';

export type SubscriptionRow = MCPAuthSchema['atc_event_subscription'];

// A stored subscription is live until its refreshBefore and expired after it.
type SubscriptionState = 'live' | 'expired';

interface StoredSubscription {
  readonly row: SubscriptionRow;
  readonly state: SubscriptionState;
}

export interface SubscriptionStore {
  readonly read: (subscriptionID: string, now: number) => Promise<StoredSubscription | null>;
  readonly readIDs: () => Promise<readonly string[]>;

  // Stores a new subscription, or replaces an expired one; false when a live
  // subscription holds the id.
  readonly start: (row: SubscriptionRow, now: number) => Promise<boolean>;
  readonly refresh: (
    subscriptionID: string,
    change: Pick<SubscriptionRow, 'secret' | 'refresh_before'>,
    now: number,
  ) => Promise<boolean>;
  readonly advance: (subscriptionID: string, position: string, now: number) => Promise<boolean>;

  // Removes an expired subscription unless a refresh renewed it since the
  // caller read the expiry it passes.
  readonly expire: (subscriptionID: string, refreshBefore: string, now: number) => Promise<boolean>;
  readonly end: (subscriptionID: string) => Promise<boolean>;

  // Removes a subscription unless a subscribe renewed it since the caller
  // read the refreshBefore it passes.
  readonly drop: (subscriptionID: string, refreshBefore: string) => Promise<boolean>;
  readonly endForClient: (clientID: string) => Promise<void>;
}

export function createSubscriptionStore(db: Kysely<MCPAuthSchema>): SubscriptionStore {
  return {
    read: async (subscriptionID, now) => {
      const row = await db
        .selectFrom('atc_event_subscription')
        .selectAll()
        .where('id', '=', subscriptionID)
        .executeTakeFirst();

      return row === undefined ? null : { row, state: pickState(row.refresh_before, now) };
    },
    readIDs: async () => {
      const rows = await db.selectFrom('atc_event_subscription').select('id').execute();

      return rows.map((row) => row.id);
    },
    start: async (row, now) => {
      const bound = getStateBound('start', now);

      const written = await db
        .insertInto('atc_event_subscription')
        .values(row)
        .onConflict((conflict) =>
          conflict
            .column('id')
            .doUpdateSet({
              secret: row.secret,
              position: row.position,
              refresh_before: row.refresh_before,
              created_at: row.created_at,
            })
            .where('atc_event_subscription.refresh_before', bound.operator, bound.at),
        )
        .executeTakeFirst();

      return (written.numInsertedOrUpdatedRows ?? 0n) > 0n;
    },
    refresh: async (subscriptionID, change, now) => {
      const bound = getStateBound('refresh', now);

      const updated = await db
        .updateTable('atc_event_subscription')
        .set(change)
        .where('id', '=', subscriptionID)
        .where('refresh_before', bound.operator, bound.at)
        .executeTakeFirst();

      return updated.numUpdatedRows > 0n;
    },
    advance: async (subscriptionID, position, now) => {
      const bound = getStateBound('advance', now);

      const updated = await db
        .updateTable('atc_event_subscription')
        .set({ position })
        .where('id', '=', subscriptionID)
        .where('refresh_before', bound.operator, bound.at)
        .executeTakeFirst();

      return updated.numUpdatedRows > 0n;
    },
    expire: async (subscriptionID, refreshBefore, now) => {
      const bound = getStateBound('expire', now);

      const removed = await db
        .deleteFrom('atc_event_subscription')
        .where('id', '=', subscriptionID)
        .where('refresh_before', '=', refreshBefore)
        .where('refresh_before', bound.operator, bound.at)
        .executeTakeFirst();

      return removed.numDeletedRows > 0n;
    },
    end: async (subscriptionID) => {
      const removed = await db
        .deleteFrom('atc_event_subscription')
        .where('id', '=', subscriptionID)
        .executeTakeFirst();

      return removed.numDeletedRows > 0n;
    },
    drop: async (subscriptionID, refreshBefore) => {
      const removed = await db
        .deleteFrom('atc_event_subscription')
        .where('id', '=', subscriptionID)
        .where('refresh_before', '=', refreshBefore)
        .executeTakeFirst();

      return removed.numDeletedRows > 0n;
    },
    endForClient: async (clientID) => {
      await db.deleteFrom('atc_event_subscription').where('client_id', '=', clientID).execute();
    },
  };
}

function pickState(refreshBefore: string, now: number): SubscriptionState {
  return Date.parse(refreshBefore) > now ? 'live' : 'expired';
}

interface StateBound {
  readonly operator: '>' | '<=';
  readonly at: string;
}

interface SubscriptionMove {
  readonly from: readonly (SubscriptionState | 'absent')[];
  readonly to: SubscriptionState | 'removed';
}

// Every write to a subscription row is one of these moves. A write touches a
// row only while the row is in a state its move starts from, and the bound on
// refreshBefore that each write carries comes from this table.
const SUBSCRIPTION_MOVES = {
  start: { from: ['absent', 'expired'], to: 'live' },
  refresh: { from: ['live'], to: 'live' },
  advance: { from: ['live'], to: 'live' },
  expire: { from: ['expired'], to: 'removed' },
  end: { from: ['live', 'expired'], to: 'removed' },
  endForClient: { from: ['live', 'expired'], to: 'removed' },
  drop: { from: ['live', 'expired'], to: 'removed' },
} as const satisfies Record<string, SubscriptionMove>;

type SubscriptionMoveName = keyof typeof SUBSCRIPTION_MOVES;

// A row's refreshBefore against the present tells its state, so a move that
// starts from live rows only, or from expired rows only, holds the write to
// rows on that side of the present. A move from both states needs no bound.
function getStateBound(
  move: Exclude<SubscriptionMoveName, 'end' | 'endForClient' | 'drop'>,
  now: number,
): StateBound {
  const from: readonly string[] = SUBSCRIPTION_MOVES[move].from;

  const at = new Date(now).toISOString();

  return from.includes('live') ? { operator: '>', at } : { operator: '<=', at };
}
