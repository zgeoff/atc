import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import type {
  EffectTarget,
  IdempotencyClaim,
  IdempotencyRecord,
} from '../idempotency/idempotency-record';
import type { StateStoreSchema } from '../sqlite/state-store-schema';

export interface IdempotencyStore {
  readonly claimIdempotencyKey: (claim: IdempotencyClaim) => Promise<IdempotencyRecord | null>;

  readonly readIdempotencyKey: (
    id: Pick<IdempotencyRecord, 'principal' | 'operation' | 'key'>,
  ) => Promise<IdempotencyRecord | null>;
  readonly readIdempotencyKeys: () => Promise<IdempotencyRecord[]>;
  readonly updateIdempotencyCompleted: (
    record: Pick<IdempotencyRecord, 'principal' | 'operation' | 'key'>,
    result: string,
    at: number,
    effectTarget: EffectTarget | null,
  ) => Promise<void>;

  readonly updateIdempotencyOutcomeUnknown: (
    record: Pick<IdempotencyRecord, 'principal' | 'operation' | 'key'>,
    at: number,
  ) => Promise<void>;

  readonly removeIdempotencyKey: (
    record: Pick<IdempotencyRecord, 'principal' | 'operation' | 'key'>,
  ) => Promise<void>;

  // Runs as a daemon starts, before it serves a request: a key still in progress belonged to a daemon that stopped mid-effect.
  readonly reconcileIdempotencyKeys: (at: number) => Promise<void>;

  // A key whose outcome is unknown is kept, so a retry keeps answering outcome_unknown instead of running anew.
  readonly removeExpiredIdempotencyKeys: (before: number) => Promise<void>;
}

export function createIdempotencyStore(db: Kysely<StateStoreSchema>): IdempotencyStore {
  return {
    claimIdempotencyKey: async (claim) => {
      const inserted = await db
        .insertInto('idempotency')
        .values({
          principal: claim.principal,
          operation: claim.operation,
          key: claim.key,
          payload_hash: claim.payloadHash,
          state: 'in_progress',
          effect_ref: claim.effectRef,
          result: null,
          created_at: claim.at,
          updated_at: claim.at,
          effect_target: null,
          effect_target_identity: null,
        })
        .onConflict((oc) => oc.columns(['principal', 'operation', 'key']).doNothing())
        .returning('key')
        .executeTakeFirst();

      if (inserted !== undefined) {
        return null;
      }

      const row = await db
        .selectFrom('idempotency')
        .selectAll()
        .where('principal', '=', claim.principal)
        .where('operation', '=', claim.operation)
        .where('key', '=', claim.key)
        .executeTakeFirstOrThrow();

      return toIdempotencyRecord(row);
    },

    readIdempotencyKey: async (id) => {
      const row = await db
        .selectFrom('idempotency')
        .selectAll()
        .where('principal', '=', id.principal)
        .where('operation', '=', id.operation)
        .where('key', '=', id.key)
        .executeTakeFirst();

      return row === undefined ? null : toIdempotencyRecord(row);
    },

    readIdempotencyKeys: async () => {
      const rows = await db
        .selectFrom('idempotency')
        .selectAll()
        .orderBy(sql`rowid`)
        .execute();

      return rows.map((row) => toIdempotencyRecord(row));
    },

    updateIdempotencyCompleted: async (record, result, at, effectTarget) => {
      await db
        .updateTable('idempotency')
        .set({
          state: 'completed',
          result,
          updated_at: at,
          effect_target: effectTarget?.target ?? null,
          effect_target_identity: effectTarget?.targetIdentity ?? null,
        })
        .where('principal', '=', record.principal)
        .where('operation', '=', record.operation)
        .where('key', '=', record.key)
        .execute();
    },

    updateIdempotencyOutcomeUnknown: async (record, at) => {
      await db
        .updateTable('idempotency')
        .set({ state: 'outcome_unknown', updated_at: at })
        .where('principal', '=', record.principal)
        .where('operation', '=', record.operation)
        .where('key', '=', record.key)
        .execute();
    },

    removeIdempotencyKey: async (record) => {
      await db
        .deleteFrom('idempotency')
        .where('principal', '=', record.principal)
        .where('operation', '=', record.operation)
        .where('key', '=', record.key)
        .execute();
    },

    reconcileIdempotencyKeys: async (at) => {
      await db.transaction().execute(async (trx) => {
        await trx
          .updateTable('idempotency')
          .set({ state: 'outcome_unknown', updated_at: at })
          .where('state', '=', 'in_progress')
          .execute();

        await trx
          .updateTable('idempotency')
          .set((eb) => ({
            state: 'completed',
            updated_at: at,
            effect_target: eb
              .selectFrom('fleet')
              .select('fleet.target')
              .whereRef('fleet.session_id', '=', 'idempotency.effect_ref'),
            effect_target_identity: eb
              .selectFrom('fleet')
              .select('fleet.target_identity')
              .whereRef('fleet.session_id', '=', 'idempotency.effect_ref'),
          }))
          .where('state', '=', 'outcome_unknown')
          .where('operation', '=', 'session.spawn')
          .where('effect_ref', 'in', (eb) => eb.selectFrom('fleet').select('session_id'))
          .execute();

        await trx
          .updateTable('idempotency')
          .set({ state: 'completed', updated_at: at })
          .where('state', '=', 'outcome_unknown')
          .where('operation', '=', 'session.message')
          .where('effect_ref', 'in', (eb) => eb.selectFrom('messages').select('id'))
          .execute();
      });
    },

    removeExpiredIdempotencyKeys: async (before) => {
      await db
        .deleteFrom('idempotency')
        .where('state', '=', 'completed')
        .where('updated_at', '<', before)
        .execute();
    },
  };
}

function toIdempotencyRecord(row: Readonly<StateStoreSchema['idempotency']>): IdempotencyRecord {
  return {
    principal: row.principal,
    operation: row.operation,
    key: row.key,
    payloadHash: row.payload_hash,
    state: row.state,
    effectRef: row.effect_ref,
    result: row.result,
    effectTarget:
      row.effect_target === null || row.effect_target_identity === null
        ? null
        : { target: row.effect_target, targetIdentity: row.effect_target_identity },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
