import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { AgentID, AgentSessionID, DaemonID, MessageID, SessionID } from '@atc/core';
import { systemClock, toAgentID, toDaemonID, toSessionID } from '@atc/core';
import type { AdapterEvent, PublishedRecord } from '@atc/protocol';
import type { HookEvent } from '@atc/protocol/session';
import { Kysely } from 'kysely';
import type { CompiledQuery, LogEvent } from 'kysely';
import { AuthBindingStore } from './auth-binding-store';
import { EventTrailStore } from './event-trail-store';
import { parseFleetEntry } from './fleet-entry';
import type { FleetEntry, FleetEntryUpdate, LegacyFleetEntry } from './fleet-entry';
import { FleetStore } from './fleet-store';
import type { EffectTarget, IdempotencyClaim, IdempotencyRecord } from './idempotency-record';
import { IdempotencyStore } from './idempotency-store';
import { MaterializationStore } from './materialization-store';
import type { MessageOwner } from './message-owner';
import type { MessageRecord, TurnSibling } from './message-record';
import { MessageStore } from './message-store';
import { PublishedRecordStore } from './published-record-store';
import type {
  RuntimeAuthBinding,
  RuntimeAuthBindingUpdate,
  RuntimeAuthGrant,
} from './runtime-auth-binding';
import { buildSQLiteDialect } from './sqlite/build-sqlite-dialect';
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

export class StateStore {
  private readonly sqlite: Database;

  private readonly db: Kysely<StateStoreSchema>;

  // The daemon this store's fleet rows belong to, minted once by the
  // migration that created session ownership.
  readonly daemonID: DaemonID;

  // The close under way or done, which every later close waits on.
  private stopping: Promise<void> | null = null;

  // The database file this store opened, which a backup must never replace.
  private readonly dbPath: string;

  private readonly fleet: FleetStore;

  private readonly trail: EventTrailStore;

  private readonly messages: MessageStore;

  private readonly idempotency: IdempotencyStore;

  private readonly materializations: MaterializationStore;

  private readonly publishedRecords: PublishedRecordStore;

  private readonly authBindings: AuthBindingStore;

  private constructor(
    sqlite: Database,
    db: Kysely<StateStoreSchema>,
    daemonID: DaemonID,
    dbPath: string,
  ) {
    this.sqlite = sqlite;
    this.dbPath = dbPath;
    this.db = db;
    this.daemonID = daemonID;

    this.fleet = new FleetStore(db, daemonID);
    this.trail = new EventTrailStore(db);
    this.messages = new MessageStore(db);
    this.idempotency = new IdempotencyStore(db);
    this.materializations = new MaterializationStore(db);
    this.publishedRecords = new PublishedRecordStore(db);
    this.authBindings = new AuthBindingStore(db);
  }

  // Migrations run statements that cannot happen inside a constructor, so
  // opening a store is this factory instead of `new`. A caller that passes
  // a query listener receives each statement the store runs once it ran.
  static async open(
    dbPath: string,
    legacyFleetPath?: string,
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

    await runMigrations(db);

    const daemonIDRow = await db
      .selectFrom('prefs')
      .select('value')
      .where('key', '=', 'daemon_id')
      .executeTakeFirstOrThrow();

    const store = new StateStore(sqlite, db, toDaemonID(daemonIDRow.value), dbPath);

    if (legacyFleetPath !== undefined) {
      await store.adoptLegacyFleet(legacyFleetPath);
    }

    return store;
  }

  loadFleet(): Promise<FleetEntry[]> {
    return this.fleet.loadFleet();
  }

  collectFleetRecency(): Promise<Map<AgentSessionID, string>> {
    return this.trail.collectFleetRecency();
  }

  writeFleet(entries: readonly FleetEntry[], removed: readonly SessionID[] = []): Promise<void> {
    return this.fleet.writeFleet(entries, removed);
  }

  updateFleetEntry(sessionID: SessionID, fields: FleetEntryUpdate): Promise<void> {
    return this.fleet.updateFleetEntry(sessionID, fields);
  }

  recordEvent(
    e: HookEvent,
    ev: Readonly<AdapterEvent> | null = null,
    at: number = systemClock.now(),
  ): Promise<void> {
    return this.trail.recordEvent(e, ev, at);
  }

  recordTrailEntry(entry: TrailEntry): Promise<boolean> {
    return this.trail.recordTrailEntry(entry);
  }

  collectEventsAfter(
    afterID: number,
    limit: number,
    scope: EventScope | null = null,
  ): Promise<StoredEvent[]> {
    return this.trail.collectEventsAfter(afterID, limit, scope);
  }

  findNote(id: number, scope: EventScope | null = null): Promise<StoredNote | null> {
    return this.trail.findNote(id, scope);
  }

  findAnswer(id: number, scope: EventScope | null = null): Promise<StoredAnswer | null> {
    return this.trail.findAnswer(id, scope);
  }

  collectLatestEvents(limit: number, scope: EventScope | null = null): Promise<StoredEvent[]> {
    return this.trail.collectLatestEvents(limit, scope);
  }

  loadLastActivityAt(
    atcID: SessionID,
    agentSessionID: AgentSessionID | undefined,
  ): Promise<number | null> {
    return this.trail.loadLastActivityAt(atcID, agentSessionID);
  }

  removeExpiredEvents(before: number): Promise<void> {
    return this.trail.removeExpiredEvents(before);
  }

  async recordSpawnDir(cwd: string, grant: SpawnTarget, at: number): Promise<void> {
    await this.db
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
  }

  async collectSpawnDirs(): Promise<SpawnDir[]> {
    const rows = await this.db
      .selectFrom('spawn_history')
      .select(['cwd', 'target', 'target_identity'])
      .orderBy('last_spawn', 'desc')
      .execute();

    return rows.map((row) => ({
      cwd: row.cwd,
      grant: { target: row.target, targetIdentity: row.target_identity },
    }));
  }

  async loadLastUsedAgent(): Promise<AgentID> {
    const row = await this.db
      .selectFrom('prefs')
      .select('value')
      .where('key', '=', 'last_used_agent')
      .executeTakeFirst();

    return toAgentID(row?.value);
  }

  async writeLastUsedAgent(agent: AgentID): Promise<void> {
    await this.db
      .insertInto('prefs')
      .values({ key: 'last_used_agent', value: agent })
      .onConflict((oc) =>
        oc.column('key').doUpdateSet((eb) => ({ value: eb.ref('excluded.value') })),
      )
      .execute();
  }

  writeMessage(record: MessageRecord): Promise<void> {
    return this.messages.writeMessage(record);
  }

  collectPendingMessages(owner: MessageOwner): Promise<MessageRecord[]> {
    return this.messages.collectPendingMessages(owner);
  }

  collectUnsettledMessages(owner: MessageOwner): Promise<MessageRecord[]> {
    return this.messages.collectUnsettledMessages(owner);
  }

  findMessage(id: MessageID, owner: MessageOwner): Promise<MessageRecord | null> {
    return this.messages.findMessage(id, owner);
  }

  findMessageByID(id: MessageID): Promise<MessageRecord | null> {
    return this.messages.findMessageByID(id);
  }

  collectTurnSiblings(record: MessageRecord): Promise<TurnSibling[]> {
    return this.messages.collectTurnSiblings(record);
  }

  updateMessageDelivered(
    id: MessageID,
    owner: MessageOwner,
    at: number,
  ): Promise<MessageRecord | null> {
    return this.messages.updateMessageDelivered(id, owner, at);
  }

  updateMessagesAnswered(
    ids: readonly MessageID[],
    owner: MessageOwner,
    answer: string,
    at: number,
    turn: string | null = null,
  ): Promise<MessageRecord[]> {
    return this.messages.updateMessagesAnswered(ids, owner, answer, at, turn);
  }

  updateMessagesUnanswered(
    ids: readonly MessageID[],
    owner: MessageOwner,
    reason: string,
    at: number,
    turn: string | null = null,
  ): Promise<MessageRecord[]> {
    return this.messages.updateMessagesUnanswered(ids, owner, reason, at, turn);
  }

  updateDeliveredMessagesUnanswered(
    owner: MessageOwner,
    reason: string,
    at: number,
  ): Promise<MessageRecord[]> {
    return this.messages.updateDeliveredMessagesUnanswered(owner, reason, at);
  }

  updateUnsettledMessagesUnanswered(
    owner: MessageOwner,
    reason: string,
    at: number,
  ): Promise<MessageRecord[]> {
    return this.messages.updateUnsettledMessagesUnanswered(owner, reason, at);
  }

  updateDeliveredMessagesQueued(owner: MessageOwner): Promise<MessageRecord[]> {
    return this.messages.updateDeliveredMessagesQueued(owner);
  }

  collectPendingNotices(senderSession: SessionID): Promise<MessageRecord[]> {
    return this.messages.collectPendingNotices(senderSession);
  }

  updateNoticeDelivered(
    id: MessageID,
    senderSession: SessionID,
    at: number,
  ): Promise<MessageRecord | null> {
    return this.messages.updateNoticeDelivered(id, senderSession, at);
  }

  updateMessageOwner(
    atcID: SessionID,
    previous: AgentSessionID | undefined,
    next: AgentSessionID,
  ): Promise<void> {
    return this.messages.updateMessageOwner(atcID, previous, next);
  }

  updateTrailOwner(atcID: SessionID, next: AgentSessionID): Promise<void> {
    return this.trail.updateTrailOwner(atcID, next);
  }

  claimIdempotencyKey(claim: IdempotencyClaim): Promise<IdempotencyRecord | null> {
    return this.idempotency.claimIdempotencyKey(claim);
  }

  findIdempotencyKey(
    id: Pick<IdempotencyRecord, 'principal' | 'operation' | 'key'>,
  ): Promise<IdempotencyRecord | null> {
    return this.idempotency.findIdempotencyKey(id);
  }

  updateIdempotencyCompleted(
    record: Pick<IdempotencyRecord, 'principal' | 'operation' | 'key'>,
    result: string,
    at: number,
    effectTarget: EffectTarget | null = null,
  ): Promise<void> {
    return this.idempotency.updateIdempotencyCompleted(record, result, at, effectTarget);
  }

  updateIdempotencyOutcomeUnknown(
    record: Pick<IdempotencyRecord, 'principal' | 'operation' | 'key'>,
    at: number,
  ): Promise<void> {
    return this.idempotency.updateIdempotencyOutcomeUnknown(record, at);
  }

  removeIdempotencyKey(
    record: Pick<IdempotencyRecord, 'principal' | 'operation' | 'key'>,
  ): Promise<void> {
    return this.idempotency.removeIdempotencyKey(record);
  }

  reconcileIdempotencyKeys(at: number): Promise<void> {
    return this.idempotency.reconcileIdempotencyKeys(at);
  }

  removeExpiredIdempotencyKeys(before: number): Promise<void> {
    return this.idempotency.removeExpiredIdempotencyKeys(before);
  }

  createMaterialization(
    row: Pick<
      WorkspaceMaterialization,
      'sessionID' | 'target' | 'dir' | 'sourceKind' | 'withheldEnv'
    >,
    at: number,
  ): Promise<void> {
    return this.materializations.createMaterialization(row, at);
  }

  updateMaterialization(
    sessionID: SessionID,
    fields: MaterializationUpdate,
    at: number,
  ): Promise<void> {
    return this.materializations.updateMaterialization(sessionID, fields, at);
  }

  findMaterialization(sessionID: SessionID): Promise<WorkspaceMaterialization | null> {
    return this.materializations.findMaterialization(sessionID);
  }

  reconcileMaterializations(at: number): Promise<void> {
    return this.materializations.reconcileMaterializations(at);
  }

  findPublishedRecord(sessionID: SessionID): Promise<PublishedRecord | null> {
    return this.publishedRecords.findPublishedRecord(sessionID);
  }

  writePublishedRecord(record: PublishedRecord): Promise<void> {
    return this.publishedRecords.writePublishedRecord(record);
  }

  removePublishedRecord(sessionID: SessionID): Promise<void> {
    return this.publishedRecords.removePublishedRecord(sessionID);
  }

  createAuthBinding(
    row: Pick<
      RuntimeAuthBinding,
      | 'hostKey'
      | 'target'
      | 'targetIdentity'
      | 'impName'
      | 'bindingHash'
      | 'bindingJSON'
      | 'attemptID'
    >,
    at: number,
  ): Promise<void> {
    return this.authBindings.createAuthBinding(row, at);
  }

  updateAuthBinding(
    hostKey: SessionID,
    fields: RuntimeAuthBindingUpdate,
    at: number,
  ): Promise<void> {
    return this.authBindings.updateAuthBinding(hostKey, fields, at);
  }

  findAuthBinding(hostKey: SessionID): Promise<RuntimeAuthBinding | null> {
    return this.authBindings.findAuthBinding(hostKey);
  }

  collectAuthBindings(): Promise<RuntimeAuthBinding[]> {
    return this.authBindings.collectAuthBindings();
  }

  upsertAuthGrant(grant: Omit<RuntimeAuthGrant, 'updatedAt'>, at: number): Promise<void> {
    return this.authBindings.upsertAuthGrant(grant, at);
  }

  collectAuthGrants(hostKey: SessionID): Promise<RuntimeAuthGrant[]> {
    return this.authBindings.collectAuthGrants(hostKey);
  }

  removeAuthBinding(hostKey: SessionID): Promise<void> {
    return this.authBindings.removeAuthBinding(hostKey);
  }

  reconcileAuthBindings(at: number): Promise<void> {
    return this.authBindings.reconcileAuthBindings(at);
  }

  writeBackup(path: string): Promise<number> {
    return writeBackup(this.db, this.dbPath, path);
  }

  // A second close, or a disposal after one, waits on the first and closes
  // nothing again; a close that fails is forgotten, so the next one retries.
  async stop(): Promise<void> {
    this.stopping ??= (async () => {
      await this.db.destroy();

      this.sqlite.close();
    })();

    const current = this.stopping;

    try {
      await current;
    } catch (error) {
      if (this.stopping === current) {
        this.stopping = null;
      }

      throw error;
    }
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.stop();
  }

  private async adoptLegacyFleet(legacyFleetPath: string): Promise<void> {
    const count = await this.db
      .selectFrom('fleet')
      .select(this.db.fn.countAll<number>().as('n'))
      .executeTakeFirst();

    if (count === undefined || count.n > 0 || !existsSync(legacyFleetPath)) {
      return;
    }

    try {
      const parsed: unknown = JSON.parse(readFileSync(legacyFleetPath, 'utf8'));

      if (!Array.isArray(parsed)) {
        return;
      }

      const legacy: LegacyFleetEntry[] = [];

      for (const entry of parsed) {
        const parsedEntry = parseFleetEntry(entry);

        if (parsedEntry !== undefined) {
          legacy.push(parsedEntry);
        }
      }

      await this.writeFleet(buildFleetFromLegacy(legacy));
    } catch {}
  }
}

// Mints each legacy entry an atc session id, then moves each sub-session
// link from the parent's agent session id to the parent's minted id.
function buildFleetFromLegacy(legacy: readonly LegacyFleetEntry[]): FleetEntry[] {
  const minted = new Map(legacy.map((entry) => [entry.agentSessionID, toSessionID(randomUUID())]));

  return legacy.map((entry) => {
    const { parent, ...rest } = entry;
    const parentID = parent === undefined ? undefined : minted.get(parent);

    return {
      ...rest,
      sessionID: minted.get(entry.agentSessionID) ?? toSessionID(randomUUID()),
      ...(parentID === undefined ? {} : { parent: parentID }),
    };
  });
}
