import type { AgentID, AgentSessionID, DaemonID, MessageID, SessionID } from '@atc/core';
import { systemClock, toAgentID, toDaemonID } from '@atc/core';
import type { AdapterEvent, PublishedRecord, RestartResult } from '@atc/protocol';
import type { HookEvent } from '@atc/protocol/session';
import { buildSQLiteDialect } from '@zgeoff/kysely-bun-sqlite';
import { Kysely } from 'kysely';
import type { CompiledQuery, LogEvent } from 'kysely';
import { createAuthBindingStore } from './create-auth-binding-store';
import { createEventTrailStore } from './create-event-trail-store';
import { createFleetStore } from './create-fleet-store';
import { createIdempotencyStore } from './create-idempotency-store';
import { createMaterializationStore } from './create-materialization-store';
import { createMessageStore } from './create-message-store';
import type {
  UpdateMessagesAnsweredOptions,
  UpdateMessagesUnansweredOptions,
} from './create-message-store';
import { createPublishedRecordStore } from './create-published-record-store';
import type { FleetEntry, FleetEntryUpdate } from './fleet-entry';
import type { EffectTarget, IdempotencyClaim, IdempotencyRecord } from './idempotency-record';
import type { MessageOwner } from './message-owner';
import type { MessageRecord, TurnSibling } from './message-record';
import type {
  RuntimeAuthBinding,
  RuntimeAuthBindingUpdate,
  RuntimeAuthGrant,
} from './runtime-auth-binding';
import { openSQLite } from './sqlite/open-sqlite';
import { runMigrations } from './sqlite/run-migrations';
import type { StateStoreSchema } from './sqlite/state-store-schema';
import type { EventScope, StoredAnswer, StoredEvent, StoredNote } from './stored-event';
import type { TrailEntry } from './trail-entry';
import type { MaterializationUpdate, WorkspaceMaterialization } from './workspace-materialization';
import { writeBackup } from './write-backup';

// The target a spawn ran on: its name and the identity the spawned session
// was bound to there.
interface SpawnTarget {
  readonly target: string;
  readonly targetIdentity: string;
}

// A directory a spawn ran in and the target it ran on.
export interface SpawnDir {
  readonly cwd: string;
  readonly grant: SpawnTarget;
}

export interface StateStore {
  // The daemon this store's fleet rows belong to, minted once by the
  // migration that created session ownership.
  readonly daemonID: DaemonID;
  readonly loadFleet: () => Promise<FleetEntry[]>;
  readonly readFleetRecency: () => Promise<Map<AgentSessionID, string>>;
  readonly writeFleet: (
    entries: readonly FleetEntry[],
    removed?: readonly SessionID[],
  ) => Promise<void>;
  readonly updateFleetEntry: (sessionID: SessionID, fields: FleetEntryUpdate) => Promise<void>;
  readonly recordEvent: (
    hookEvent: HookEvent,
    ev?: Readonly<AdapterEvent> | null,
    at?: number,
  ) => Promise<void>;
  readonly recordTrailEntry: (entry: TrailEntry) => Promise<boolean>;
  readonly recordRestart: (result: RestartResult, detail: string, at: number) => Promise<void>;
  readonly readEventsAfter: (
    afterID: number,
    limit: number,
    scope?: EventScope | null,
  ) => Promise<StoredEvent[]>;
  readonly readNote: (id: number, scope?: EventScope | null) => Promise<StoredNote | null>;
  readonly readAnswer: (id: number, scope?: EventScope | null) => Promise<StoredAnswer | null>;
  readonly readLatestEvents: (limit: number, scope?: EventScope | null) => Promise<StoredEvent[]>;
  readonly loadLastActivityAt: (
    atcID: SessionID,
    agentSessionID: AgentSessionID | undefined,
  ) => Promise<number | null>;
  readonly removeExpiredEvents: (before: number) => Promise<void>;
  readonly recordSpawnDir: (cwd: string, grant: SpawnTarget, at: number) => Promise<void>;
  readonly readSpawnDirs: () => Promise<SpawnDir[]>;
  readonly loadLastUsedAgent: () => Promise<AgentID>;
  readonly writeLastUsedAgent: (agent: AgentID) => Promise<void>;
  readonly writeMessage: (record: MessageRecord) => Promise<void>;
  readonly readPendingMessages: (owner: MessageOwner) => Promise<MessageRecord[]>;
  readonly readUnsettledMessages: (owner: MessageOwner) => Promise<MessageRecord[]>;
  readonly readMessage: (id: MessageID, owner: MessageOwner) => Promise<MessageRecord | null>;
  readonly readMessageByID: (id: MessageID) => Promise<MessageRecord | null>;
  readonly readTurnSiblings: (record: MessageRecord) => Promise<TurnSibling[]>;

  // Marks the message delivered and writes the trail entry built from the marked record in one
  // transaction, so both commit or neither does. A missed mark writes nothing.
  readonly updateMessageDelivered: (
    id: MessageID,
    owner: MessageOwner,
    at: number,
    buildEntry: (record: MessageRecord) => TrailEntry,
  ) => Promise<MessageRecord | null>;
  readonly updateMessagesAnswered: (
    ids: readonly MessageID[],
    owner: MessageOwner,
    options: UpdateMessagesAnsweredOptions,
  ) => Promise<MessageRecord[]>;
  readonly updateMessagesUnanswered: (
    ids: readonly MessageID[],
    owner: MessageOwner,
    options: UpdateMessagesUnansweredOptions,
  ) => Promise<MessageRecord[]>;
  readonly updateDeliveredMessagesUnanswered: (
    owner: MessageOwner,
    reason: string,
    at: number,
  ) => Promise<MessageRecord[]>;
  readonly updateUnsettledMessagesUnanswered: (
    owner: MessageOwner,
    reason: string,
    at: number,
  ) => Promise<MessageRecord[]>;
  readonly readPendingNotices: (senderSession: SessionID) => Promise<MessageRecord[]>;
  readonly updateNoticeDelivered: (
    id: MessageID,
    senderSession: SessionID,
    at: number,
  ) => Promise<MessageRecord | null>;
  readonly updateMessageOwner: (
    atcID: SessionID,
    previous: AgentSessionID | undefined,
    next: AgentSessionID,
  ) => Promise<void>;
  readonly updateTrailOwner: (atcID: SessionID, next: AgentSessionID) => Promise<void>;
  readonly claimIdempotencyKey: (claim: IdempotencyClaim) => Promise<IdempotencyRecord | null>;
  readonly readIdempotencyKey: (
    id: Pick<IdempotencyRecord, 'principal' | 'operation' | 'key'>,
  ) => Promise<IdempotencyRecord | null>;
  readonly updateIdempotencyCompleted: (
    record: Pick<IdempotencyRecord, 'principal' | 'operation' | 'key'>,
    result: string,
    at: number,
    effectTarget?: EffectTarget | null,
  ) => Promise<void>;
  readonly updateIdempotencyOutcomeUnknown: (
    record: Pick<IdempotencyRecord, 'principal' | 'operation' | 'key'>,
    at: number,
  ) => Promise<void>;
  readonly removeIdempotencyKey: (
    record: Pick<IdempotencyRecord, 'principal' | 'operation' | 'key'>,
  ) => Promise<void>;
  readonly reconcileIdempotencyKeys: (at: number) => Promise<void>;
  readonly removeExpiredIdempotencyKeys: (before: number) => Promise<void>;
  readonly createMaterialization: (
    row: Pick<
      WorkspaceMaterialization,
      'sessionID' | 'target' | 'directory' | 'sourceKind' | 'withheldEnv'
    >,
    at: number,
  ) => Promise<void>;
  readonly updateMaterialization: (
    sessionID: SessionID,
    fields: MaterializationUpdate,
    at: number,
  ) => Promise<void>;
  readonly readMaterialization: (sessionID: SessionID) => Promise<WorkspaceMaterialization | null>;
  readonly reconcileMaterializations: (at: number) => Promise<void>;
  readonly readPublishedRecord: (sessionID: SessionID) => Promise<PublishedRecord | null>;
  readonly writePublishedRecord: (record: PublishedRecord) => Promise<void>;
  readonly removePublishedRecord: (sessionID: SessionID) => Promise<void>;
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
  readonly readAuthBindings: () => Promise<RuntimeAuthBinding[]>;
  readonly upsertAuthGrant: (
    grant: Omit<RuntimeAuthGrant, 'updatedAt'>,
    at: number,
  ) => Promise<void>;
  readonly readAuthGrants: (hostKey: SessionID) => Promise<RuntimeAuthGrant[]>;
  readonly removeAuthBinding: (hostKey: SessionID) => Promise<void>;
  readonly reconcileAuthBindings: (at: number) => Promise<void>;
  readonly writeBackup: (path: string) => Promise<number>;

  // A second close, or a disposal after one, waits on the first and closes
  // nothing again; a close that fails is forgotten, so the next one retries.
  readonly stop: () => Promise<void>;
  readonly [Symbol.asyncDispose]: () => Promise<void>;
}

// Opening a store runs the migrations before it returns. A caller that
// passes a query listener receives each statement the store runs once it ran.
export async function createStateStore(
  dbPath: string,
  onQuery?: (query: CompiledQuery) => void,
): Promise<StateStore> {
  const sqlite = openSQLite(dbPath);

  const db = new Kysely<StateStoreSchema>({
    dialect: buildSQLiteDialect(sqlite),
    ...(onQuery === undefined
      ? {}
      : {
          log: (event: LogEvent) => {
            if (event.level === 'query') {
              onQuery(event.query);
            }
          },
        }),
  });

  try {
    await runMigrations(db);
  } catch (error) {
    await db.destroy();

    sqlite.close();
    throw error;
  }

  const daemonIDRow = await db
    .selectFrom('prefs')
    .select('value')
    .where('key', '=', 'daemon_id')
    .executeTakeFirstOrThrow();

  const daemonID = toDaemonID(daemonIDRow.value);

  // The close under way or done, which every later close waits on.
  let stopping: Promise<void> | null = null;
  const fleet = createFleetStore(db, daemonID);
  const trail = createEventTrailStore(db);
  const messages = createMessageStore(db);
  const idempotency = createIdempotencyStore(db);
  const materializations = createMaterializationStore(db);
  const publishedRecords = createPublishedRecordStore(db);
  const authBindings = createAuthBindingStore(db);

  const stop = async () => {
    stopping ??= (async () => {
      await db.destroy();

      sqlite.close();
    })();

    const current = stopping;

    try {
      await current;
    } catch (error) {
      if (stopping === current) {
        stopping = null;
      }

      throw error;
    }
  };

  return {
    daemonID,
    loadFleet: () => fleet.loadFleet(),
    readFleetRecency: () => trail.readFleetRecency(),
    writeFleet: (entries, removed = []) => fleet.writeFleet(entries, removed),
    updateFleetEntry: (sessionID, fields) => fleet.updateFleetEntry(sessionID, fields),
    recordEvent: (hookEvent, ev = null, at = systemClock.now()) =>
      trail.recordEvent(hookEvent, ev, at),
    recordTrailEntry: (entry) => trail.recordTrailEntry(entry),
    recordRestart: (result, detail, at) => trail.recordRestart(result, detail, at),
    readEventsAfter: (afterID, limit, scope = null) => trail.readEventsAfter(afterID, limit, scope),
    readNote: (id, scope = null) => trail.readNote(id, scope),
    readAnswer: (id, scope = null) => trail.readAnswer(id, scope),
    readLatestEvents: (limit, scope = null) => trail.readLatestEvents(limit, scope),
    loadLastActivityAt: (atcID, agentSessionID) => trail.loadLastActivityAt(atcID, agentSessionID),
    removeExpiredEvents: (before) => trail.removeExpiredEvents(before),

    recordSpawnDir: async (cwd, grant, at) => {
      await db
        .insertInto('spawn_history')
        .values({
          cwd,
          target: grant.target,
          target_identity: grant.targetIdentity,
          last_spawn: at,
        })
        .onConflict((oc) =>
          oc
            .columns(['cwd', 'target', 'target_identity'])
            .doUpdateSet((eb) => ({ last_spawn: eb.ref('excluded.last_spawn') })),
        )
        .execute();
    },

    readSpawnDirs: async () => {
      const rows = await db
        .selectFrom('spawn_history')
        .select(['cwd', 'target', 'target_identity'])
        .orderBy('last_spawn', 'desc')
        .execute();

      return rows.map((row) => ({
        cwd: row.cwd,
        grant: { target: row.target, targetIdentity: row.target_identity },
      }));
    },

    loadLastUsedAgent: async () => {
      const row = await db
        .selectFrom('prefs')
        .select('value')
        .where('key', '=', 'last_used_agent')
        .executeTakeFirst();

      return toAgentID(row?.value);
    },

    writeLastUsedAgent: async (agent) => {
      await db
        .insertInto('prefs')
        .values({ key: 'last_used_agent', value: agent })
        .onConflict((oc) =>
          oc.column('key').doUpdateSet((eb) => ({ value: eb.ref('excluded.value') })),
        )
        .execute();
    },

    writeMessage: (record) => messages.writeMessage(record),
    readPendingMessages: (owner) => messages.readPendingMessages(owner),
    readUnsettledMessages: (owner) => messages.readUnsettledMessages(owner),
    readMessage: (id, owner) => messages.readMessage(id, owner),
    readMessageByID: (id) => messages.readMessageByID(id),
    readTurnSiblings: (record) => messages.readTurnSiblings(record),
    updateMessageDelivered: (id, owner, at, buildEntry) =>
      db.transaction().execute(async (transaction) => {
        const record = await createMessageStore(transaction).updateMessageDelivered(id, owner, at);

        if (record !== null) {
          await createEventTrailStore(transaction).recordTrailEntry(buildEntry(record));
        }

        return record;
      }),
    updateMessagesAnswered: (ids, owner, options) =>
      messages.updateMessagesAnswered(ids, owner, options),
    updateMessagesUnanswered: (ids, owner, options) =>
      messages.updateMessagesUnanswered(ids, owner, options),
    updateDeliveredMessagesUnanswered: (owner, reason, at) =>
      messages.updateDeliveredMessagesUnanswered(owner, reason, at),
    updateUnsettledMessagesUnanswered: (owner, reason, at) =>
      messages.updateUnsettledMessagesUnanswered(owner, reason, at),
    readPendingNotices: (senderSession) => messages.readPendingNotices(senderSession),
    updateNoticeDelivered: (id, senderSession, at) =>
      messages.updateNoticeDelivered(id, senderSession, at),
    updateMessageOwner: (atcID, previous, next) =>
      messages.updateMessageOwner(atcID, previous, next),
    updateTrailOwner: (atcID, next) => trail.updateTrailOwner(atcID, next),
    claimIdempotencyKey: (claim) => idempotency.claimIdempotencyKey(claim),
    readIdempotencyKey: (id) => idempotency.readIdempotencyKey(id),
    updateIdempotencyCompleted: (record, result, at, effectTarget = null) =>
      idempotency.updateIdempotencyCompleted(record, result, at, effectTarget),
    updateIdempotencyOutcomeUnknown: (record, at) =>
      idempotency.updateIdempotencyOutcomeUnknown(record, at),
    removeIdempotencyKey: (record) => idempotency.removeIdempotencyKey(record),
    reconcileIdempotencyKeys: (at) => idempotency.reconcileIdempotencyKeys(at),
    removeExpiredIdempotencyKeys: (before) => idempotency.removeExpiredIdempotencyKeys(before),
    createMaterialization: (row, at) => materializations.createMaterialization(row, at),
    updateMaterialization: (sessionID, fields, at) =>
      materializations.updateMaterialization(sessionID, fields, at),
    readMaterialization: (sessionID) => materializations.readMaterialization(sessionID),
    reconcileMaterializations: (at) => materializations.reconcileMaterializations(at),
    readPublishedRecord: (sessionID) => publishedRecords.readPublishedRecord(sessionID),
    writePublishedRecord: (record) => publishedRecords.writePublishedRecord(record),
    removePublishedRecord: (sessionID) => publishedRecords.removePublishedRecord(sessionID),
    createAuthBinding: (row, at) => authBindings.createAuthBinding(row, at),
    updateAuthBinding: (hostKey, fields, at) => authBindings.updateAuthBinding(hostKey, fields, at),
    readAuthBinding: (hostKey) => authBindings.readAuthBinding(hostKey),
    readAuthBindings: () => authBindings.readAuthBindings(),
    upsertAuthGrant: (grant, at) => authBindings.upsertAuthGrant(grant, at),
    readAuthGrants: (hostKey) => authBindings.readAuthGrants(hostKey),
    removeAuthBinding: (hostKey) => authBindings.removeAuthBinding(hostKey),
    reconcileAuthBindings: (at) => authBindings.reconcileAuthBindings(at),

    // The database file this store opened, which a backup must never replace.
    writeBackup: (path) => writeBackup(db, dbPath, path),

    stop,
    [Symbol.asyncDispose]: () => stop(),
  };
}
