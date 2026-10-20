import type { Clock, MessageID, SessionID } from '@atc/core';
import { toMessageID } from '@atc/core';
import type { DaemonAnswer } from '@atc/protocol';
import { MESSAGE_ANSWER_SCHEMA } from '@atc/protocol';
import { DaemonError } from '@atc/protocol/wire';
import type { EventMsg } from '@atc/protocol/wire';
import type {
  IdempotencyRecord,
  MessageOwner,
  MessageRecord,
  MessageStatus,
  StateStore,
  TrailEntry,
} from '@atc/store';
import { isTreeInReach } from '../auth/is-tree-in-reach';
import type { TargetAccess } from '../auth/target-access';
import type { DaemonContext, MessageRefusal, TapClient } from '../daemon-context';
import type { EventSignal } from '../transport/event-signal';
import type { IdempotencyLedger, KeyedRequest } from '../transport/idempotency-ledger';
import { buildMessageOwner } from './build-message-owner';
import { buildMessageSender } from './build-message-sender';
import { buildMessageTrailEntry } from './build-message-trail-entry';
import { buildNoticeTrailEntry } from './build-notice-trail-entry';
import { buildSessionMessageEvent } from './build-session-message-event';
import { drainInbox } from './drain-inbox';
import type { InboxSource } from './drain-inbox';
import { emitInboxClosed } from './emit-inbox-closed';
import type { HookScope } from './make-hook-runner';
import type { MessageCaller } from './message-caller';
import { MessageRefusedError } from './message-refused-error';
import { mintMessageID } from './mint-message-id';
import type { Session } from './session';
import type { SessionRuntime } from './session-runtime';
import type { SessionManager } from './sessions';
import type { TapRegistry } from './tap-registry';

interface MessageServiceDeps {
  readonly manager: Pick<SessionManager, 'sessions' | 'findAdapter' | 'isLocalTarget'>;
  readonly store: Pick<
    StateStore,
    | 'recordTrailEntry'
    | 'writeMessage'
    | 'readMessage'
    | 'readMessageByID'
    | 'readTurnSiblings'
    | 'readPendingMessages'
    | 'readPendingNotices'
    | 'updateMessageDelivered'
    | 'updateNoticeDelivered'
    | 'updateDeliveredMessagesUnanswered'
    | 'updateUnsettledMessagesUnanswered'
    | 'updateDeliveredMessagesQueued'
  >;
  readonly clock: Clock;
  readonly ledger: Pick<IdempotencyLedger, 'run'>;
  readonly taps: TapRegistry<TapClient>;
  readonly findRuntime: (sessionID: SessionID) => SessionRuntime | undefined;

  // Wakes the reads that wait for the trail to grow.
  readonly eventSignal: Pick<EventSignal, 'emit' | 'generation' | 'disposed' | 'waitForNext'>;
  readonly emitEvent: (event: EventMsg, scope: HookScope | null) => void;
  readonly findHookScope: (sessionID: SessionID) => HookScope | null;

  // Whether the daemon saw the session's process end, until a harness
  // starts for it again.
  readonly isProcessEnded: (sessionID: SessionID) => boolean;

  // How long a started session may go without a tap before a message to it
  // is refused.
  readonly tapGraceMs: number;
}

type MessageView = NonNullable<Awaited<ReturnType<DaemonContext['readMessage']>>>;

// every status change lands in the trail before it is broadcast; a keyed send writes at most
// once per key, and a retry answers with the message's current status
export class MessageService {
  private readonly manager: MessageServiceDeps['manager'];

  private readonly store: MessageServiceDeps['store'];

  private readonly clock: Clock;

  private readonly ledger: MessageServiceDeps['ledger'];

  private readonly taps: TapRegistry<TapClient>;

  private readonly findRuntime: MessageServiceDeps['findRuntime'];

  private readonly eventSignal: MessageServiceDeps['eventSignal'];

  private readonly emitEvent: MessageServiceDeps['emitEvent'];

  private readonly findHookScope: MessageServiceDeps['findHookScope'];

  private readonly isProcessEnded: MessageServiceDeps['isProcessEnded'];

  private readonly tapGraceMs: number;

  private readonly inboxSource: InboxSource;

  // Writes queued messages one at a time so the store's insertion order is
  // the order of their sent times, which the inbox drains by.
  private lastMessageWrite: Promise<void> = Promise.resolve();

  constructor(deps: MessageServiceDeps) {
    this.manager = deps.manager;
    this.store = deps.store;
    this.clock = deps.clock;
    this.ledger = deps.ledger;
    this.taps = deps.taps;
    this.findRuntime = deps.findRuntime;
    this.eventSignal = deps.eventSignal;
    this.emitEvent = deps.emitEvent;
    this.findHookScope = deps.findHookScope;
    this.isProcessEnded = deps.isProcessEnded;
    this.tapGraceMs = deps.tapGraceMs;

    this.inboxSource = {
      taps: deps.taps,
      findLinkedOwner: (sessionID) => {
        const session = this.manager.sessions.find((x) => x.id === sessionID);

        return session === undefined ? null : buildMessageOwner(session);
      },
      readPendingMessages: (owner) => this.store.readPendingMessages(owner),
      readPendingNotices: (senderSession) => this.store.readPendingNotices(senderSession),
    };
  }

  // A trail write that fails never fails the message request or note
  // behind it. Returns false when the entry was not written: a failed
  // write, or a note the trail already holds.
  async recordTrailEntry(entry: TrailEntry): Promise<boolean> {
    let written: boolean;

    try {
      written = await this.store.recordTrailEntry(entry);
    } catch {
      return false;
    }

    if (written) {
      this.eventSignal.emit();
    }

    return written;
  }

  // Notes a message status change in the trail before broadcasting it, so
  // a client reading the trail on the broadcast finds the change already
  // there.
  async recordMessageStatus(sessionID: SessionID, record: MessageRecord): Promise<void> {
    const session = this.manager.sessions.find((x) => x.id === sessionID);

    await this.recordTrailEntry(buildMessageTrailEntry(sessionID, session?.agentSessionID, record));

    this.emitEvent(buildSessionMessageEvent(sessionID, record), this.findHookScope(sessionID));
  }

  // Notes an answer notice change in the sender session's trail.
  async recordNoticeStatus(
    record: MessageRecord,
    kind: 'notice-queued' | 'notice-delivered',
  ): Promise<void> {
    if (record.senderSession === undefined) {
      return;
    }

    const sender = this.manager.sessions.find((x) => x.id === record.senderSession);

    await this.recordTrailEntry(
      buildNoticeTrailEntry(record.senderSession, sender?.agentSessionID, record, kind),
    );
  }

  // the store queues each notice once, in the settling statement, so a stop after it keeps the
  // notice queued and a repeated report queues nothing; a sender with no tap gets it on attach
  async recordAnswerNotice(record: MessageRecord): Promise<void> {
    if (record.senderSession === undefined || record.noticeQueuedAt === undefined) {
      return;
    }

    try {
      await this.recordNoticeStatus(record, 'notice-queued');

      void this.drainSessionInbox(record.senderSession);
    } catch {}
  }

  // Hands the session's tap the next message or notice it waits for.
  drainSessionInbox(sessionID: SessionID): Promise<void> {
    return drainInbox(sessionID, this.inboxSource);
  }

  // A session whose process ended leaves no turn to report on the messages
  // it was given, so each one it holds delivered becomes unanswered; a
  // session gone for good also leaves each one it holds queued.
  async updateEndedMessages(
    sessionID: SessionID,
    owner: MessageOwner,
    gone = false,
  ): Promise<void> {
    try {
      const at = this.clock.now();

      const unanswered = gone
        ? await this.store.updateUnsettledMessagesUnanswered(owner, 'session_ended', at)
        : await this.store.updateDeliveredMessagesUnanswered(owner, 'session_ended', at);

      for (const record of unanswered) {
        await this.recordMessageStatus(sessionID, record);
        await this.recordAnswerNotice(record);
      }
    } catch {}
  }

  // A session that a restore revives takes again each message its ended
  // process held delivered, once the revived process's tap attaches. Rejects
  // when the store refuses the requeue, so the caller can close them instead.
  async updateRevivedMessages(sessionID: SessionID, owner: MessageOwner): Promise<void> {
    const queued = await this.store.updateDeliveredMessagesQueued(owner);

    for (const record of queued) {
      await this.recordMessageStatus(sessionID, record);
    }
  }

  // While another live session resumes the same agent session, the store
  // cannot tell which process holds a message, so none is marked.
  async updateEndedSessionMessages(session: Session, gone = false): Promise<void> {
    const shared =
      session.agentSessionID !== undefined &&
      this.manager.sessions.some(
        (x) =>
          x.id !== session.id &&
          x.agentSessionID === session.agentSessionID &&
          (x.pty !== null || (x.kind === 'headless' && x.state !== 'exited')),
      );

    if (!shared) {
      await this.updateEndedMessages(session.id, buildMessageOwner(session), gone);
    }
  }

  // under an access, a session whose tree leaves it before the write refuses as an unknown one
  // does; a refusal in a keyed send's start throws, so the claim drops and a retry runs fresh
  async writeSessionMessage(
    sessionID: SessionID,
    caller: MessageCaller,
    text: string,
    keyed: KeyedRequest | null,
    access: TargetAccess | null,
    callerSession: SessionID | null,
  ): Promise<DaemonAnswer<'session.message'> | MessageRefusal> {
    const requireInReach = () => {
      if (access !== null && !isTreeInReach(this.manager.sessions, sessionID, access)) {
        throw new MessageRefusedError('missing');
      }
    };

    const senderSession = this.findNoticeSender(callerSession, access);

    try {
      if (keyed === null) {
        const refusal = this.findMessageRefusal(sessionID);

        if (refusal !== null) {
          return refusal;
        }

        const record = await this.writeQueuedMessage(
          sessionID,
          caller,
          text,
          mintMessageID(),
          requireInReach,
          senderSession,
        );

        return { message: record.id, status: record.status };
      }

      const effectRef = mintMessageID();

      return await this.ledger.run({
        operation: 'session.message',
        keyed,
        effectRef,
        start: async () => {
          requireInReach();

          const refusal = this.findMessageRefusal(sessionID);

          if (refusal !== null) {
            throw new MessageRefusedError(refusal);
          }

          const record = await this.writeQueuedMessage(
            sessionID,
            caller,
            text,
            effectRef,
            requireInReach,
            senderSession,
          );

          return { message: record.id, status: record.status };
        },

        // The message row is the effect, and the start already wrote it.
        settle: () => Promise.resolve(),
        replay: (record) => this.loadMessageReplay(record),
      });
    } catch (error) {
      if (error instanceof MessageRefusedError) {
        return error.refusal;
      }

      throw error;
    }
  }

  // every status change wakes the signal, so a wake rereads the message and returns once its
  // status moved from the one at call time; answered and unanswered are final
  async readMessage(messageID: MessageID, waitMs: number): Promise<MessageView | null> {
    const deadline = this.clock.now() + waitMs;
    let initialStatus: MessageStatus | null = null;

    for (;;) {
      const generation = this.eventSignal.generation;

      const view = await this.readMessageView(messageID);

      if (view === null) {
        return null;
      }

      initialStatus ??= view.record.status;

      const remaining = deadline - this.clock.now();

      if (
        view.record.status !== initialStatus ||
        view.record.status === 'answered' ||
        view.record.status === 'unanswered' ||
        remaining <= 0 ||
        this.eventSignal.disposed
      ) {
        return view;
      }

      await this.eventSignal.waitForNext(generation, remaining);
    }
  }

  // A tap attached here replaces the session's previous tap, which learns
  // its subscription is over.
  attachTap(
    client: TapClient,
    sessionID: SessionID,
    access: TargetAccess | null,
    notices: boolean,
  ): 'ok' | 'missing' | 'unsupported' {
    const session = this.manager.sessions.find((x) => x.id === sessionID);

    if (session === undefined) {
      return 'missing';
    }

    if (this.manager.findAdapter(session.agent)?.takesMessages !== true) {
      return 'unsupported';
    }

    emitInboxClosed(
      this.taps.attach(sessionID, client, access === null, notices),
      sessionID,
      'replaced',
    );

    const runtime = this.findRuntime(sessionID);

    if (runtime !== undefined) {
      runtime.tapAttached = true;
    }

    void this.drainSessionInbox(sessionID);

    return 'ok';
  }

  detachTap(client: TapClient, sessionID: SessionID): void {
    if (this.taps.isTap(sessionID, client)) {
      this.taps.removeSession(sessionID);
    }
  }

  // Under an access, only a message sent to this atc id is the session's
  // to ack, as with the inbox drain.
  async ackMessage(
    client: TapClient,
    sessionID: SessionID,
    messageID: MessageID,
    access: TargetAccess | null,
  ): Promise<MessageRecord | 'not_tapping' | 'unknown'> {
    const session = this.manager.sessions.find((x) => x.id === sessionID);

    if (session === undefined || !this.taps.isTap(sessionID, client)) {
      return 'not_tapping';
    }

    const owner = access === null ? buildMessageOwner(session) : { atcID: session.id };

    const delivered = await this.store.updateMessageDelivered(messageID, owner, this.clock.now());

    void this.drainSessionInbox(sessionID);

    if (delivered !== null) {
      await this.recordMessageStatus(sessionID, delivered);

      // a tap can outlive its process, so an ack can land after the end marked its messages; a
      // process is surely gone once its exit was seen or a local session has no terminal, while a
      // remote host that lost the connection or went to sleep may still run it
      const live =
        session.pty !== null || (session.kind === 'headless' && session.state !== 'exited');

      if (
        !live &&
        (this.isProcessEnded(session.id) || this.manager.isLocalTarget(session.target))
      ) {
        await this.updateEndedSessionMessages(session);

        const settled = await this.store.readMessage(messageID, owner);

        return settled ?? delivered;
      }

      return delivered;
    }

    const current = await this.store.readMessage(messageID, owner);

    return current ?? 'unknown';
  }

  async ackNotice(
    client: TapClient,
    sessionID: SessionID,
    messageID: MessageID,
  ): Promise<MessageRecord | 'not_tapping' | 'unknown'> {
    if (
      !this.manager.sessions.some((x) => x.id === sessionID) ||
      !this.taps.isTap(sessionID, client)
    ) {
      return 'not_tapping';
    }

    const delivered = await this.store.updateNoticeDelivered(
      messageID,
      sessionID,
      this.clock.now(),
    );

    void this.drainSessionInbox(sessionID);

    if (delivered !== null) {
      await this.recordNoticeStatus(delivered, 'notice-delivered');

      return delivered;
    }

    const current = await this.store.readMessageByID(messageID);

    return current?.senderSession === sessionID && current.noticeQueuedAt !== undefined
      ? current
      : 'unknown';
  }

  // Why the session refuses a message right now, or null when it takes one.
  private findMessageRefusal(sessionID: SessionID): MessageRefusal | null {
    const session = this.manager.sessions.find((x) => x.id === sessionID);

    if (session === undefined) {
      return 'missing';
    }

    if (!(session.pty !== null || (session.kind === 'headless' && session.state !== 'exited'))) {
      return 'dead';
    }

    if (this.manager.findAdapter(session.agent)?.takesMessages !== true) {
      return 'unsupported';
    }

    const runtime = this.findRuntime(sessionID);

    if (
      runtime !== undefined &&
      runtime.startedAt !== null &&
      !runtime.tapAttached &&
      this.clock.now() - runtime.startedAt >= this.tapGraceMs
    ) {
      return 'no_tap';
    }

    return null;
  }

  // a caller outside a session that takes messages, or whose tree is out of reach, gets no
  // notice and reads the answer with message.get
  private findNoticeSender(
    callerSession: SessionID | null,
    access: TargetAccess | null,
  ): SessionID | null {
    if (callerSession === null) {
      return null;
    }

    const session = this.manager.sessions.find((x) => x.id === callerSession);

    if (session === undefined || this.manager.findAdapter(session.agent)?.takesMessages !== true) {
      return null;
    }

    if (access !== null && !isTreeInReach(this.manager.sessions, session.id, access)) {
      return null;
    }

    return session.id;
  }

  // only the write itself can reject: every later step swallows its own failure, so a rejection
  // means nothing was written; the caller's check runs again once earlier writes land
  private async writeQueuedMessage(
    sessionID: SessionID,
    caller: MessageCaller,
    text: string,
    id: MessageID,
    requireWriteInReach: () => void,
    senderSession: SessionID | null,
  ): Promise<MessageRecord> {
    const session = this.manager.sessions.find((x) => x.id === sessionID);
    const previousWrite = this.lastMessageWrite;
    const written = Promise.withResolvers<void>();

    this.lastMessageWrite = written.promise;

    await previousWrite;

    // A session sender's name is the one it holds as its message is written.
    const sender = buildMessageSender(caller, this.manager.sessions);

    const record: MessageRecord = {
      id,
      atcID: sessionID,
      ...(session?.agentSessionID === undefined ? {} : { agentSessionID: session.agentSessionID }),
      from: sender.name,
      sender,
      text,
      status: 'queued',
      sentAt: this.clock.now(),
      ...(senderSession === null ? {} : { senderSession }),
    };

    try {
      // The write boundary: the reach check and the start of the row write
      // run in one synchronous step, so no wait lets the session's tree
      // leave the access between the check and the write it allows.
      requireWriteInReach();

      await this.store.writeMessage(record);
      await this.recordMessageStatus(sessionID, record);
    } finally {
      written.resolve();
    }

    await this.drainSessionInbox(sessionID);

    return record;
  }

  // A retried send answers with the message's current status, so a caller
  // that lost the first answer learns where its message stands now.
  private async loadMessageReplay(
    record: IdempotencyRecord,
  ): Promise<DaemonAnswer<'session.message'>> {
    const current = await this.store.readMessageByID(toMessageID(record.effectRef));

    if (current !== null) {
      return { message: current.id, status: current.status };
    }

    const result: unknown = record.result === null ? null : JSON.parse(record.result);
    const stored = MESSAGE_ANSWER_SCHEMA.safeParse(result);

    if (stored.success) {
      return stored.data;
    }

    throw new DaemonError(
      'internal',
      `the message under idempotency key '${record.key}' has no stored row`,
      { effectRef: record.effectRef },
    );
  }

  // A message belongs to the live session holding its atc id, else to the
  // one holding its agent session id, else to the atc id it was sent to.
  private async readMessageView(messageID: MessageID): Promise<MessageView | null> {
    const record = await this.store.readMessageByID(messageID);

    if (record === null) {
      return null;
    }

    const owner =
      this.manager.sessions.find((x) => x.id === record.atcID) ??
      this.manager.sessions.find(
        (x) => record.agentSessionID !== undefined && x.agentSessionID === record.agentSessionID,
      );

    return {
      session: owner?.id ?? record.atcID,
      record,
      answeredWith: await this.store.readTurnSiblings(record),
    };
  }
}
