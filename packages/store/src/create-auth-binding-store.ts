import type { SessionID } from '@atc/core';
import { toSessionID } from '@atc/core';
import type { Kysely } from 'kysely';
import type {
  RuntimeAuthBinding,
  RuntimeAuthBindingUpdate,
  RuntimeAuthGrant,
} from './runtime-auth-binding';
import type { StateStoreSchema } from './sqlite/state-store-schema';

// Each host's runtime auth binding and the grant rows it holds.
export interface AuthBindingStore {
  // Records a host's binding as its first attempt starts provisioning it,
  // at the first revision, before the host exists.
  readonly createAuthBinding: (
    row: Pick<
      RuntimeAuthBinding,
      | 'hostKey'
      | 'target'
      | 'targetIdentity'
      | 'hostName'
      | 'bindingHash'
      | 'bindingJSON'
      | 'attemptID'
    >,
    at: number,
  ) => Promise<void>;
  readonly updateAuthBinding: (
    hostKey: SessionID,
    fields: RuntimeAuthBindingUpdate,
    at: number,
  ) => Promise<void>;
  readonly readAuthBinding: (hostKey: SessionID) => Promise<RuntimeAuthBinding | null>;

  // Every host's binding, by host key.
  readonly readAuthBindings: () => Promise<RuntimeAuthBinding[]>;

  // Writes one secret's grant row for a host, or moves the existing one to
  // the given phase, revision and attempt.
  readonly upsertAuthGrant: (
    grant: Omit<RuntimeAuthGrant, 'updatedAt'>,
    at: number,
  ) => Promise<void>;

  // A host's grant rows, by secret name.
  readonly readAuthGrants: (hostKey: SessionID) => Promise<RuntimeAuthGrant[]>;

  // Drops a host's binding and every grant row it holds together, once
  // the broker confirms the host and its grants gone.
  readonly removeAuthBinding: (hostKey: SessionID) => Promise<void>;

  // Runs once as a daemon starts, before it serves a request: a grant still
  // granting belonged to a daemon that stopped before the broker answered, so
  // whether the broker holds it is uncertain until its grant list is read.
  readonly reconcileAuthBindings: (at: number) => Promise<void>;
}

export function createAuthBindingStore(db: Kysely<StateStoreSchema>): AuthBindingStore {
  return {
    createAuthBinding: async (row, at) => {
      await db
        .insertInto('runtime_auth_binding')
        .values({
          host_key: row.hostKey,
          target: row.target,
          target_identity: row.targetIdentity,
          host_name: row.hostName,
          host_id: null,
          revision: 1,
          binding_hash: row.bindingHash,
          binding_json: row.bindingJSON,
          state: 'provisioning',
          attempt_id: row.attemptID,
          host_created_by_attempt: 0,
          rebind_revision: null,
          rebind_binding_hash: null,
          rebind_binding_json: null,
          rebind_attempt_id: null,
          created_at: at,
          updated_at: at,
          revoked_at: null,
        })
        .execute();
    },

    updateAuthBinding: async (hostKey, fields, at) => {
      await db
        .updateTable('runtime_auth_binding')
        .set({
          ...(fields.state === undefined ? {} : { state: fields.state }),
          ...(fields.hostID === undefined ? {} : { host_id: fields.hostID }),
          ...(fields.hostCreatedByAttempt === undefined
            ? {}
            : { host_created_by_attempt: fields.hostCreatedByAttempt ? 1 : 0 }),
          ...(fields.revision === undefined ? {} : { revision: fields.revision }),
          ...(fields.bindingHash === undefined ? {} : { binding_hash: fields.bindingHash }),
          ...(fields.bindingJSON === undefined ? {} : { binding_json: fields.bindingJSON }),
          ...(fields.attemptID === undefined ? {} : { attempt_id: fields.attemptID }),
          ...(fields.rebind === undefined
            ? {}
            : {
                rebind_revision: fields.rebind?.revision ?? null,
                rebind_binding_hash: fields.rebind?.bindingHash ?? null,
                rebind_binding_json: fields.rebind?.bindingJSON ?? null,
                rebind_attempt_id: fields.rebind?.attemptID ?? null,
              }),
          ...(fields.revokedAt === undefined ? {} : { revoked_at: fields.revokedAt }),
          updated_at: at,
        })
        .where('host_key', '=', hostKey)
        .execute();
    },

    readAuthBinding: async (hostKey) => {
      const row = await db
        .selectFrom('runtime_auth_binding')
        .selectAll()
        .where('host_key', '=', hostKey)
        .executeTakeFirst();

      return row === undefined ? null : toRuntimeAuthBinding(row);
    },

    readAuthBindings: async () => {
      const rows = await db
        .selectFrom('runtime_auth_binding')
        .selectAll()
        .orderBy('host_key')
        .execute();

      return rows.map((row) => toRuntimeAuthBinding(row));
    },

    upsertAuthGrant: async (grant, at) => {
      await db
        .insertInto('runtime_auth_grant')
        .values({
          host_key: grant.hostKey,
          secret: grant.secret,
          revision: grant.revision,
          attempt_id: grant.attemptID,
          preexisting: grant.preexisting ? 1 : 0,
          phase: grant.phase,
          updated_at: at,
        })
        .onConflict((oc) =>
          oc.columns(['host_key', 'secret']).doUpdateSet((eb) => ({
            revision: eb.ref('excluded.revision'),
            attempt_id: eb.ref('excluded.attempt_id'),
            preexisting: eb.ref('excluded.preexisting'),
            phase: eb.ref('excluded.phase'),
            updated_at: eb.ref('excluded.updated_at'),
          })),
        )
        .execute();
    },

    readAuthGrants: async (hostKey) => {
      const rows = await db
        .selectFrom('runtime_auth_grant')
        .selectAll()
        .where('host_key', '=', hostKey)
        .orderBy('secret')
        .execute();

      return rows.map((row) => ({
        hostKey: toSessionID(row.host_key),
        secret: row.secret,
        revision: row.revision,
        attemptID: row.attempt_id,
        preexisting: row.preexisting === 1,
        phase: row.phase,
        updatedAt: row.updated_at,
      }));
    },

    removeAuthBinding: async (hostKey) => {
      await db.transaction().execute(async (trx) => {
        await trx.deleteFrom('runtime_auth_grant').where('host_key', '=', hostKey).execute();
        await trx.deleteFrom('runtime_auth_binding').where('host_key', '=', hostKey).execute();
      });
    },

    reconcileAuthBindings: async (at) => {
      await db
        .updateTable('runtime_auth_grant')
        .set({ phase: 'uncertain', updated_at: at })
        .where('phase', '=', 'granting')
        .execute();
    },
  };
}

function toRuntimeAuthBinding(
  row: Readonly<StateStoreSchema['runtime_auth_binding']>,
): RuntimeAuthBinding {
  return {
    hostKey: toSessionID(row.host_key),
    target: row.target,
    targetIdentity: row.target_identity,
    hostName: row.host_name,
    hostID: row.host_id,
    revision: row.revision,
    bindingHash: row.binding_hash,
    bindingJSON: row.binding_json,
    state: row.state,
    attemptID: row.attempt_id,
    hostCreatedByAttempt: row.host_created_by_attempt === 1,
    rebind:
      row.rebind_revision === null ||
      row.rebind_binding_hash === null ||
      row.rebind_binding_json === null ||
      row.rebind_attempt_id === null
        ? null
        : {
            revision: row.rebind_revision,
            bindingHash: row.rebind_binding_hash,
            bindingJSON: row.rebind_binding_json,
            attemptID: row.rebind_attempt_id,
          },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revokedAt: row.revoked_at,
  };
}
