import type { AgentSessionID, SessionID } from '@atc/core';
import { isRecord, toAgentSessionID, toMessageID, toSessionID } from '@atc/core';
import type { AdapterEvent } from '@atc/protocol';
import type { HookEvent } from '@atc/protocol/session';
import { sql } from 'kysely';
import type { Expression, ExpressionBuilder, Kysely, SqlBool } from 'kysely';
import type { StateStoreSchema } from './sqlite/state-store-schema';
import type { EventScope, StoredAnswer, StoredEvent, StoredNote } from './stored-event';
import type { TrailEntry } from './trail-entry';

// The hook events and trail entries a session leaves behind, kept in the
// events table.
export class EventTrailStore {
  private readonly db: Kysely<StateStoreSchema>;

  constructor(db: Kysely<StateStoreSchema>) {
    this.db = db;
  }

  // The latest hook-event timestamp per agent session id, from the event
  // trail. Sessions that never reported an event are absent.
  async readFleetRecency(): Promise<Map<AgentSessionID, string>> {
    const rows = await this.db
      .selectFrom('events')
      .select((expressionBuilder) => ['session_id', expressionBuilder.fn.max('ts').as('ts')])
      .where('session_id', 'is not', null)
      .groupBy('session_id')
      .execute();

    const recency = new Map<AgentSessionID, string>();

    for (const row of rows) {
      if (row.session_id === null) {
        continue;
      }

      recency.set(toAgentSessionID(row.session_id), row.ts);
    }

    return recency;
  }

  // Records a hook event in the trail, stamped with the given time in epoch
  // milliseconds, or the system clock's when absent.
  async recordEvent(
    hookEvent: HookEvent,
    ev: Readonly<AdapterEvent> | null,
    at: number,
  ): Promise<void> {
    const payload = isRecord(hookEvent.payload) ? hookEvent.payload : {};
    const rawMessage = payload['message'];
    const rawSessionID = payload['session_id'] ?? payload['sessionId'];
    const message = typeof rawMessage === 'string' ? rawMessage : null;
    const sessionID = typeof rawSessionID === 'string' ? rawSessionID : null;
    const atcID: string = hookEvent.atcId;

    await this.db
      .insertInto('events')
      .values({
        ts: new Date(at).toISOString(),
        atc_id: atcID,
        event: hookEvent.event,
        message,
        session_id: sessionID,
        kind: ev === null ? null : ev.kind,
        detail: ev?.detail ?? null,
      })
      .execute();
  }

  // Returns whether the entry was written: a note whose id the trail
  // already holds is left out.
  async recordTrailEntry(entry: TrailEntry): Promise<boolean> {
    const result = await this.db
      .insertInto('events')
      .values({
        ts: new Date(entry.at).toISOString(),
        atc_id: entry.atcID,
        event: entry.kind === 'note' ? 'SessionNote' : 'SessionMessage',

        // The message column holds the message id or the note label; the reads hand it back by kind.
        message: entry.kind === 'note' ? entry.label : entry.message,
        session_id: entry.agentSessionID,
        kind: entry.kind,
        detail: entry.detail,
        note_id: entry.kind === 'note' ? (entry.noteID ?? null) : null,
        note_text: entry.kind === 'note' ? entry.text : null,
        answer_text: entry.kind === 'message-answered' ? entry.text : null,
      })
      .onConflict((oc) => oc.column('note_id').doNothing())
      .executeTakeFirst();

    return result.numInsertedOrUpdatedRows !== 0n;
  }

  async readEventsAfter(
    afterID: number,
    limit: number,
    scope: EventScope | null,
  ): Promise<StoredEvent[]> {
    const rows = await this.db
      .selectFrom('events')
      .select(['id', 'ts', 'atc_id', 'session_id', 'kind', 'detail', 'message'])
      .where('id', '>', afterID)
      .where((expressionBuilder) => buildTrailFilter(expressionBuilder))
      .where((eb) => buildScopeMatch(eb, scope))
      .orderBy('id', 'asc')
      .limit(limit)
      .execute();

    return buildStoredEvents(rows);
  }

  // A row that is not a note, or that lies outside the scope, misses as a
  // row the trail never held does.
  async readNote(id: number, scope: EventScope | null): Promise<StoredNote | null> {
    const row = await this.db
      .selectFrom('events')
      .select(['id', 'ts', 'atc_id', 'session_id', 'message', 'detail', 'note_text'])
      .where('id', '=', id)
      .where('kind', '=', 'note')
      .where((eb) => buildScopeMatch(eb, scope))
      .executeTakeFirst();

    if (row === undefined) {
      return null;
    }

    return {
      id: row.id,
      at: Date.parse(row.ts),
      atcID: toSessionID(row.atc_id),
      agentSessionID: row.session_id === null ? null : toAgentSessionID(row.session_id),
      label: row.message ?? '',
      text: row.note_text ?? row.detail ?? '',
      complete: row.note_text !== null,
    };
  }

  // A row that is not an answered message, or that lies outside the scope,
  // misses as a row the trail never held does.
  async readAnswer(id: number, scope: EventScope | null): Promise<StoredAnswer | null> {
    const row = await this.db
      .selectFrom('events')
      .select(['id', 'ts', 'atc_id', 'session_id', 'message', 'detail', 'answer_text'])
      .where('id', '=', id)
      .where('kind', '=', 'message-answered')
      .where((eb) => buildScopeMatch(eb, scope))
      .executeTakeFirst();

    if (row === undefined || row.message === null) {
      return null;
    }

    return {
      id: row.id,
      at: Date.parse(row.ts),
      atcID: toSessionID(row.atc_id),
      agentSessionID: row.session_id === null ? null : toAgentSessionID(row.session_id),
      message: toMessageID(row.message),
      text: row.answer_text ?? row.detail ?? '',
      complete: row.answer_text !== null,
    };
  }

  async readLatestEvents(limit: number, scope: EventScope | null): Promise<StoredEvent[]> {
    const rows = await this.db
      .selectFrom('events')
      .select(['id', 'ts', 'atc_id', 'session_id', 'kind', 'detail', 'message'])
      .where((expressionBuilder) => buildTrailFilter(expressionBuilder))
      .where((eb) => buildScopeMatch(eb, scope))
      .orderBy('id', 'desc')
      .limit(limit)
      .execute();

    return buildStoredEvents(rows).toReversed();
  }

  // Matches the session by either id, since rows written before atc session
  // ids stayed stable across restores carry an earlier atc id.
  async loadLastActivityAt(
    atcID: SessionID,
    agentSessionID: AgentSessionID | undefined,
  ): Promise<number | null> {
    const row = await this.db
      .selectFrom('events')
      .select((expressionBuilder) => expressionBuilder.fn.max('ts').as('ts'))
      .where((eb) =>
        eb.or([
          eb('atc_id', '=', atcID),
          ...(agentSessionID === undefined ? [] : [eb('session_id', '=', agentSessionID)]),
        ]),
      )
      .executeTakeFirst();

    return row?.ts === null || row?.ts === undefined ? null : Date.parse(row.ts);
  }

  // The newest row under each atc id and each agent session id stays, so a
  // session's last activity and restore order survive; past the cutoff it
  // stays only while a fleet row holds either id.
  async removeExpiredEvents(before: number): Promise<void> {
    const cutoff = new Date(before).toISOString();

    await this.db
      .deleteFrom('events')
      .where((expressionBuilder) => buildExpiredMatch(expressionBuilder, cutoff))
      .execute();
  }

  // Trail entries written before the agent reported its session id carry
  // none; this stamps them once it is known, so they follow the session
  // across a restore.
  async updateTrailOwner(atcID: SessionID, next: AgentSessionID): Promise<void> {
    await this.db
      .updateTable('events')
      .set({ session_id: next })
      .where('atc_id', '=', atcID)
      .where('session_id', 'is', null)
      .where('kind', 'in', [
        'message-queued',
        'message-delivered',
        'message-answered',
        'message-unanswered',
        'notice-queued',
        'notice-delivered',
        'note',
      ])
      .execute();
  }
}

function buildExpiredMatch(
  expressionBuilder: ExpressionBuilder<StateStoreSchema, 'events'>,
  cutoff: string,
): Expression<SqlBool> {
  const isPastCutoff = expressionBuilder('events.ts', '<', cutoff);
  const isHeldByFleet = expressionBuilder.exists(buildFleetHolders(expressionBuilder));

  const newestUnderAtcID = expressionBuilder
    .selectFrom('events as newer')
    .select((subqueryBuilder) => subqueryBuilder.fn.max('newer.ts').as('ts'))
    .whereRef('newer.atc_id', '=', 'events.atc_id');

  const newestUnderSessionID = expressionBuilder
    .selectFrom('events as newer')
    .select((subqueryBuilder) => subqueryBuilder.fn.max('newer.ts').as('ts'))
    .whereRef('newer.session_id', '=', 'events.session_id');

  const isOlderUnderSessionID = expressionBuilder.or([
    expressionBuilder('events.session_id', 'is', null),
    expressionBuilder('events.ts', '<', newestUnderSessionID),
  ]);

  const isOlderThanNewest = expressionBuilder.and([
    expressionBuilder('events.ts', '<', newestUnderAtcID),
    isOlderUnderSessionID,
  ]);

  const isUnheldPastCutoff = expressionBuilder.and([
    isPastCutoff,
    expressionBuilder.not(isHeldByFleet),
  ]);

  const isTrail = buildTrailFilter(expressionBuilder);

  return expressionBuilder.and([
    expressionBuilder.or([isPastCutoff, expressionBuilder.not(isTrail)]),
    expressionBuilder.or([isUnheldPastCutoff, isOlderThanNewest]),
  ]);
}

function buildFleetHolders(expressionBuilder: ExpressionBuilder<StateStoreSchema, 'events'>) {
  return expressionBuilder
    .selectFrom('fleet')
    .select(sql.lit(1).as('held'))
    .where((subqueryBuilder) => {
      const holdsAtcID = subqueryBuilder(
        'fleet.session_id',
        '=',
        subqueryBuilder.ref('events.atc_id'),
      );

      const holdsAgentSessionID = subqueryBuilder.and([
        subqueryBuilder('events.session_id', 'is not', null),
        subqueryBuilder('fleet.agent_session_id', '=', subqueryBuilder.ref('events.session_id')),
      ]);

      return subqueryBuilder.or([holdsAtcID, holdsAgentSessionID]);
    });
}

// Spelled as the partial index's predicate, with the literal inlined rather
// than bound, so SQLite can match the index.
function buildTrailFilter(
  expressionBuilder: ExpressionBuilder<StateStoreSchema, 'events'>,
): Expression<SqlBool> {
  return expressionBuilder.and([
    expressionBuilder('kind', 'is not', null),
    expressionBuilder('kind', '!=', sql.lit('heartbeat')),
  ]);
}

function buildScopeMatch(
  eb: ExpressionBuilder<StateStoreSchema, 'events'>,
  scope: EventScope | null,
): Expression<SqlBool> {
  if (scope === null) {
    return eb.lit(true);
  }

  if (scope.atcIDs.length === 0 && scope.agentSessionIDs.length === 0) {
    return eb.lit(false);
  }

  return eb.or([
    ...(scope.atcIDs.length === 0 ? [] : [eb('atc_id', 'in', scope.atcIDs)]),
    ...(scope.agentSessionIDs.length === 0 ? [] : [eb('session_id', 'in', scope.agentSessionIDs)]),
  ]);
}

interface EventRow {
  readonly id: number;
  readonly ts: string;
  readonly atc_id: string;
  readonly session_id: string | null;
  readonly kind: string | null;
  readonly detail: string | null;
  readonly message: string | null;
}

function buildStoredEvents(rows: readonly EventRow[]): StoredEvent[] {
  const events: StoredEvent[] = [];

  for (const row of rows) {
    if (row.kind === null) {
      continue;
    }

    events.push({
      id: row.id,
      at: Date.parse(row.ts),
      atcID: toSessionID(row.atc_id),
      agentSessionID: row.session_id === null ? null : toAgentSessionID(row.session_id),
      kind: row.kind,
      ...buildTrailFields(row.kind, row.detail, row.message),
    });
  }

  return events;
}

const MESSAGE_TRAIL_KINDS: ReadonlySet<string> = new Set([
  'message-queued',
  'message-delivered',
  'message-answered',
  'message-unanswered',
  'notice-queued',
  'notice-delivered',
]);

// Message and note rows keep their message id or label where hook rows keep
// the hook's message, so only hook rows fall back to it for a detail.
function buildTrailFields(
  kind: string,
  detail: string | null,
  message: string | null,
): Pick<StoredEvent, 'detail' | 'message' | 'label'> {
  if (MESSAGE_TRAIL_KINDS.has(kind)) {
    return { detail, ...(message === null ? {} : { message: toMessageID(message) }) };
  }

  if (kind === 'note') {
    return { detail, ...(message === null ? {} : { label: message }) };
  }

  return { detail: detail ?? message };
}
