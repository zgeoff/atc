import type { AgentSessionID, MessageID, SessionID } from '@atc/core';
import { toAgentSessionID, toMessageID, toSessionID } from '@atc/core';
import { MESSAGE_SENDER_SCHEMA } from '@atc/protocol/wire';
import type { MessageSender } from '@atc/protocol/wire';
import { sql } from 'kysely';
import type { Expression, ExpressionBuilder, Kysely, SqlBool } from 'kysely';
import { getMessageSources } from './get-message-sources';
import type { MessageOwner } from './message-owner';
import type { MessageRecord, TurnSibling } from './message-record';
import type { StateStoreSchema } from './sqlite/state-store-schema';

// The messages sent to sessions, their settling, and the answer notices
// queued for the sessions that sent them.
export class MessageStore {
  private readonly db: Kysely<StateStoreSchema>;

  constructor(db: Kysely<StateStoreSchema>) {
    this.db = db;
  }

  async writeMessage(record: MessageRecord): Promise<void> {
    await this.db
      .insertInto('messages')
      .values({
        id: record.id,
        atc_id: record.atcID,
        agent_session_id: record.agentSessionID ?? null,
        sender: record.from,
        sender_kind: record.sender?.kind ?? null,
        sender_id: findSenderID(record.sender),
        text: record.text,
        status: record.status,
        sent_at: record.sentAt,
        delivered_at: record.deliveredAt ?? null,
        answered_at: record.answeredAt ?? null,
        answer: record.answer ?? null,
        unanswered_at: record.unansweredAt ?? null,
        unanswered_reason: record.unansweredReason ?? null,
        sender_session: record.senderSession ?? null,
        notice_queued_at: record.noticeQueuedAt ?? null,
        notice_delivered_at: record.noticeDeliveredAt ?? null,
      })
      .execute();
  }

  async readPendingMessages(owner: MessageOwner): Promise<MessageRecord[]> {
    const rows = await this.db
      .selectFrom('messages')
      .selectAll()
      .where('status', '=', 'queued')
      .where((eb) => buildOwnerFilter(eb, owner))
      .orderBy('sent_at', 'asc')
      .orderBy(sql`rowid`, 'asc')
      .execute();

    return rows.map((row) => toMessageRecord(row));
  }

  // The messages the owner holds queued or delivered, which no turn has
  // settled yet, oldest first.
  async readUnsettledMessages(owner: MessageOwner): Promise<MessageRecord[]> {
    const rows = await this.db
      .selectFrom('messages')
      .selectAll()
      .where('status', 'in', ['queued', 'delivered'])
      .where((eb) => buildOwnerFilter(eb, owner))
      .orderBy('sent_at', 'asc')
      .orderBy(sql`rowid`, 'asc')
      .execute();

    return rows.map((row) => toMessageRecord(row));
  }

  async readMessage(id: MessageID, owner: MessageOwner): Promise<MessageRecord | null> {
    const row = await this.db
      .selectFrom('messages')
      .selectAll()
      .where('id', '=', id)
      .where((eb) => buildOwnerFilter(eb, owner))
      .executeTakeFirst();

    return row === undefined ? null : toMessageRecord(row);
  }

  async readMessageByID(id: MessageID): Promise<MessageRecord | null> {
    const row = await this.db
      .selectFrom('messages')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    return row === undefined ? null : toMessageRecord(row);
  }

  // The other messages of the same session the given message's turn
  // answered, oldest first; none when the message has no turn or no answer.
  // A message left unanswered keeps its turn but shares no answer.
  async readTurnSiblings(record: MessageRecord): Promise<TurnSibling[]> {
    if (record.turn === undefined || record.status !== 'answered') {
      return [];
    }

    const owner: MessageOwner =
      record.agentSessionID === undefined
        ? { atcID: record.atcID }
        : { atcID: record.atcID, agentSessionID: record.agentSessionID };

    const rows = await this.db
      .selectFrom('messages')
      .select(['id', 'atc_id'])
      .where('turn_id', '=', record.turn)
      .where('status', '=', 'answered')
      .where('id', '!=', record.id)
      .where((eb) => buildOwnerFilter(eb, owner))
      .orderBy('sent_at', 'asc')
      .orderBy(sql`rowid`, 'asc')
      .execute();

    return rows.map((row) => ({ id: toMessageID(row.id), atcID: toSessionID(row.atc_id) }));
  }

  async updateMessageDelivered(
    id: MessageID,
    owner: MessageOwner,
    at: number,
  ): Promise<MessageRecord | null> {
    const row = await this.db
      .updateTable('messages')
      .set({ status: 'delivered', delivered_at: at })
      .where('id', '=', id)
      .where('status', 'in', getMessageSources('delivered'))
      .where((eb) => buildOwnerFilter(eb, owner))
      .returningAll()
      .executeTakeFirst();

    return row === undefined ? null : toMessageRecord(row);
  }

  // One statement, so a reader sees all of one turn's messages answered or
  // none, and it queues the answer notice of each message with a sender
  // session too, so a stop after it never loses a notice.
  async updateMessagesAnswered(
    ids: readonly MessageID[],
    owner: MessageOwner,
    answer: string,
    at: number,
    turn: string | null,
  ): Promise<MessageRecord[]> {
    if (ids.length === 0) {
      return [];
    }

    const rows = await this.db
      .updateTable('messages')
      .set((eb) => ({
        status: 'answered',
        answered_at: at,
        answer,
        turn_id: turn,
        notice_queued_at: buildNoticeQueuedAt(eb, at),
      }))
      .where('id', 'in', ids)
      .where('status', 'in', getMessageSources('answered'))
      .where((eb) => buildOwnerFilter(eb, owner))
      .returningAll()
      .execute();

    return rows
      .map((row) => toMessageRecord(row))
      .toSorted((left, right) => left.sentAt - right.sentAt);
  }

  // One statement, so a reader sees all of one turn's messages settled or
  // none, and it queues the answer notice of each message with a sender
  // session too. A message already settled is left as it is.
  async updateMessagesUnanswered(
    ids: readonly MessageID[],
    owner: MessageOwner,
    reason: string,
    at: number,
    turn: string | null,
  ): Promise<MessageRecord[]> {
    if (ids.length === 0) {
      return [];
    }

    const rows = await this.db
      .updateTable('messages')
      .set((eb) => ({
        status: 'unanswered',
        unanswered_at: at,
        unanswered_reason: reason,
        turn_id: turn,
        notice_queued_at: buildNoticeQueuedAt(eb, at),
      }))
      .where('id', 'in', ids)
      .where('status', 'in', getMessageSources('unanswered'))
      .where((eb) => buildOwnerFilter(eb, owner))
      .returningAll()
      .execute();

    return rows
      .map((row) => toMessageRecord(row))
      .toSorted((left, right) => left.sentAt - right.sentAt);
  }

  // For a session whose process ended, so no turn is left to settle its
  // delivered messages; a queued message waits for the next process. One
  // statement also queues the answer notice of each with a sender session.
  async updateDeliveredMessagesUnanswered(
    owner: MessageOwner,
    reason: string,
    at: number,
  ): Promise<MessageRecord[]> {
    const rows = await this.db
      .updateTable('messages')
      .set((eb) => ({
        status: 'unanswered',
        unanswered_at: at,
        unanswered_reason: reason,
        notice_queued_at: buildNoticeQueuedAt(eb, at),
      }))
      .where('status', 'in', getMessageSources('unanswered', ['delivered']))
      .where((eb) => buildOwnerFilter(eb, owner))
      .returningAll()
      .execute();

    return rows
      .map((row) => toMessageRecord(row))
      .toSorted((left, right) => left.sentAt - right.sentAt);
  }

  // For a session that is gone for good, so no process will take its
  // messages, queued or delivered. One statement also queues the answer
  // notice of each with a sender session.
  async updateUnsettledMessagesUnanswered(
    owner: MessageOwner,
    reason: string,
    at: number,
  ): Promise<MessageRecord[]> {
    const rows = await this.db
      .updateTable('messages')
      .set((eb) => ({
        status: 'unanswered',
        unanswered_at: at,
        unanswered_reason: reason,
        notice_queued_at: buildNoticeQueuedAt(eb, at),
      }))
      .where('status', 'in', getMessageSources('unanswered'))
      .where((eb) => buildOwnerFilter(eb, owner))
      .returningAll()
      .execute();

    return rows
      .map((row) => toMessageRecord(row))
      .toSorted((left, right) => left.sentAt - right.sentAt);
  }

  // The answer notices queued for the sender session and not yet taken by
  // its tap, oldest first.
  async readPendingNotices(senderSession: SessionID): Promise<MessageRecord[]> {
    const rows = await this.db
      .selectFrom('messages')
      .selectAll()
      .where('sender_session', '=', senderSession)
      .where('notice_queued_at', 'is not', null)
      .where('notice_delivered_at', 'is', null)
      .orderBy('notice_queued_at', 'asc')
      .orderBy(sql`rowid`, 'asc')
      .execute();

    return rows.map((row) => toMessageRecord(row));
  }

  // Marks the answer notice the sender session's tap took. Returns the
  // message when this call marked it, else null: the notice was already
  // taken, was never queued, or belongs to another sender.
  async updateNoticeDelivered(
    id: MessageID,
    senderSession: SessionID,
    at: number,
  ): Promise<MessageRecord | null> {
    const row = await this.db
      .updateTable('messages')
      .set({ notice_delivered_at: at })
      .where('id', '=', id)
      .where('sender_session', '=', senderSession)
      .where('notice_queued_at', 'is not', null)
      .where('notice_delivered_at', 'is', null)
      .returningAll()
      .executeTakeFirst();

    return row === undefined ? null : toMessageRecord(row);
  }

  // Messages sent before the agent reported its session id carry no agent
  // session id; this stamps them once it is known, and moves every message
  // from a previous agent session id to a changed one.
  async updateMessageOwner(
    atcID: SessionID,
    previous: AgentSessionID | undefined,
    next: AgentSessionID,
  ): Promise<void> {
    await this.db
      .updateTable('messages')
      .set({ agent_session_id: next })
      .where((eb) => {
        const unstamped = eb.and([eb('atc_id', '=', atcID), eb('agent_session_id', 'is', null)]);

        return previous === undefined
          ? unstamped
          : eb.or([unstamped, eb('agent_session_id', '=', previous)]);
      })
      .execute();
  }
}

// The client id of a connector or the atc id of a session, which the row
// keeps in one column; null for a local program, the owner, and a message
// with no sender.
function findSenderID(sender: MessageSender | undefined): string | null {
  if (sender?.kind === 'connector') {
    return sender.client;
  }

  return sender?.kind === 'session' ? sender.session : null;
}

function buildOwnerFilter(
  eb: ExpressionBuilder<StateStoreSchema, 'messages'>,
  owner: MessageOwner,
): Expression<SqlBool> {
  const byAtcID = eb('atc_id', '=', owner.atcID);

  return owner.agentSessionID === undefined
    ? byAtcID
    : eb.or([byAtcID, eb('agent_session_id', '=', owner.agentSessionID)]);
}

function toMessageRecord(row: Readonly<StateStoreSchema['messages']>): MessageRecord {
  return {
    id: toMessageID(row.id),
    atcID: toSessionID(row.atc_id),
    ...(row.agent_session_id === null
      ? {}
      : { agentSessionID: toAgentSessionID(row.agent_session_id) }),
    from: row.sender,
    ...buildMessageSender(row),
    text: row.text,
    status: row.status,
    sentAt: row.sent_at,
    ...(row.delivered_at === null ? {} : { deliveredAt: row.delivered_at }),
    ...(row.answered_at === null ? {} : { answeredAt: row.answered_at }),
    ...(row.answer === null ? {} : { answer: row.answer }),
    ...(row.unanswered_at === null ? {} : { unansweredAt: row.unanswered_at }),
    ...(row.unanswered_reason === null ? {} : { unansweredReason: row.unanswered_reason }),
    ...(row.turn_id === null ? {} : { turn: row.turn_id }),
    ...(row.sender_session === null ? {} : { senderSession: toSessionID(row.sender_session) }),
    ...(row.notice_queued_at === null ? {} : { noticeQueuedAt: row.notice_queued_at }),
    ...(row.notice_delivered_at === null ? {} : { noticeDeliveredAt: row.notice_delivered_at }),
  };
}

// A row the daemon wrote with a typed sender reads back with it; a row from
// before, or one whose kind or id this build cannot read, holds only the
// sender's name.
function buildMessageSender(
  row: Readonly<StateStoreSchema['messages']>,
): { readonly sender: MessageSender } | Record<string, never> {
  const id = row.sender_id ?? undefined;

  const parsed = MESSAGE_SENDER_SCHEMA.safeParse({
    kind: row.sender_kind,
    name: row.sender,
    ...(row.sender_kind === 'connector' ? { client: id } : {}),
    ...(row.sender_kind === 'session' ? { session: id } : {}),
  });

  return parsed.success ? { sender: parsed.data } : {};
}

// The time a settling statement queues a message's answer notice at: the
// settle time for a message that has a sender session, else none, since
// no session waits on its outcome.
function buildNoticeQueuedAt(
  eb: ExpressionBuilder<StateStoreSchema, 'messages'>,
  at: number,
): Expression<number | null> {
  // oxlint-disable-next-line promise/prefer-await-to-then -- Kysely's CASE builder names its branch method then; it returns no promise
  return eb.case().when('sender_session', 'is not', null).then(at).end();
}
