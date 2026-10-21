import type { Kysely } from 'kysely';
import type { EffectTarget, IdempotencyClaim, IdempotencyRecord } from './idempotency-record';
import type { StateStoreSchema } from './sqlite/state-store-schema';

// The idempotency ledger: one key per principal and operation, and the
// outcome of the effect it guards.
export interface IdempotencyStore {
  // Records a key in progress unless one is already held under the same
  // principal and operation. Returns null when this call claimed the key,
  // else the record the key already holds.
  readonly claimIdempotencyKey: (claim: IdempotencyClaim) => Promise<IdempotencyRecord | null>;

  // The record a key holds under its principal and operation, or null when
  // the ledger holds none.
  readonly readIdempotencyKey: (
    id: Pick<IdempotencyRecord, 'principal' | 'operation' | 'key'>,
  ) => Promise<IdempotencyRecord | null>;
  readonly updateIdempotencyCompleted: (
    record: Pick<IdempotencyRecord, 'principal' | 'operation' | 'key'>,
    result: string,
    at: number,
    effectTarget: EffectTarget | null,
  ) => Promise<void>;

  // Keeps a claim whose effect may still stand as outcome_unknown, so a
  // retry answers from it and never runs the effect again.
  readonly updateIdempotencyOutcomeUnknown: (
    record: Pick<IdempotencyRecord, 'principal' | 'operation' | 'key'>,
    at: number,
  ) => Promise<void>;

  // Drops a claim whose effect never started, so a retry runs it fresh.
  readonly removeIdempotencyKey: (
    record: Pick<IdempotencyRecord, 'principal' | 'operation' | 'key'>,
  ) => Promise<void>;

  // Runs as a daemon starts, before it serves a request: a key still in
  // progress belonged to a daemon that stopped mid-effect. One whose effect
  // left its row behind completes; one that left no trace stays unknown.
  readonly reconcileIdempotencyKeys: (at: number) => Promise<void>;

  // Only completed keys expire: a key whose outcome is unknown stays, so a
  // retry of it keeps answering outcome_unknown instead of running anew.
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

        // A spawn that completes here records the target its fleet row holds,
        // as a spawn that completes as it runs does.
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
