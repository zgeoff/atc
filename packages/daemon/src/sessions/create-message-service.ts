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
import type { TargetAccess } from '../auth/build-target-access-from-grants';
import { isTreeInReach } from '../auth/is-tree-in-reach';
import type { DaemonContext, MessageRefusal, TapClient } from '../daemon-context';
import type { EventSignal } from '../transport/create-event-signal';
import type { IdempotencyLedger, KeyedRequest } from '../transport/create-idempotency-ledger';
import { buildMessageOwner } from './build-message-owner';
import { buildMessageSender } from './build-message-sender';
import { buildMessageTrailEntry } from './build-message-trail-entry';
import { buildNoticeTrailEntry } from './build-notice-trail-entry';
import { buildSessionMessageEvent } from './build-session-message-event';
import type { SessionManager } from './create-session-manager';
import type { SessionRuntime } from './create-session-runtime';
import type { TapRegistry } from './create-tap-registry';
import { drainInbox } from './drain-inbox';
import type { InboxSource } from './drain-inbox';
import { emitInboxClosed } from './emit-inbox-closed';
import type { HookScope } from './make-hook-runner';
import type { MessageCaller } from './message-caller';
import { MessageRefusedError } from './message-refused-error';
import { mintMessageID } from './mint-message-id';
import type { Session } from './session';

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
export interface MessageService {
  // A trail write that fails never fails the message request or note
  // behind it. Returns false when the entry was not written: a failed
  // write, or a note the trail already holds.
  readonly recordTrailEntry: (entry: TrailEntry) => Promise<boolean>;

  // Notes a message status change in the trail before broadcasting it, so
  // a client reading the trail on the broadcast finds the change already
  // there.
  readonly recordMessageStatus: (sessionID: SessionID, record: MessageRecord) => Promise<void>;

  // Marks the message delivered and notes it in the trail in one commit, then broadcasts it.
  // Returns null when the mark missed. A failed write rejects.
  readonly markMessageDelivered: (
    sessionID: SessionID,
    messageID: MessageID,
    owner: MessageOwner,
  ) => Promise<MessageRecord | null>;

  // Notes an answer notice change in the sender session's trail.
  readonly recordNoticeStatus: (
    record: MessageRecord,
    kind: 'notice-queued' | 'notice-delivered',
  ) => Promise<void>;

  // the store queues each notice once, in the settling statement, so a stop after it keeps the
  // notice queued and a repeated report queues nothing; a sender with no tap gets it on attach
  readonly recordAnswerNotice: (record: MessageRecord) => Promise<void>;

  // Hands the session's tap the next message or notice it waits for.
  readonly drainSessionInbox: (sessionID: SessionID) => Promise<void>;

  // A session whose process ended leaves no turn to report on the messages
  // it was given, so each one it holds delivered becomes unanswered; a
  // session gone for good also leaves each one it holds queued.
  readonly updateEndedMessages: (
    sessionID: SessionID,
    owner: MessageOwner,
    gone?: boolean,
  ) => Promise<void>;

  // While another live session resumes the same agent session, the store
  // cannot tell which process holds a message, so none is marked.
  readonly updateEndedSessionMessages: (session: Session, gone?: boolean) => Promise<void>;

  // under an access, a session whose tree leaves it before the write refuses as an unknown one
  // does; a refusal in a keyed send's start throws, so the claim drops and a retry runs fresh
  readonly writeSessionMessage: (
    sessionID: SessionID,
    caller: MessageCaller,
    text: string,
    keyed: KeyedRequest | null,
    access: TargetAccess | null,
    callerSession: SessionID | null,
  ) => Promise<DaemonAnswer<'session.message'> | MessageRefusal>;

  // every status change wakes the signal, so a wake rereads the message and returns once its
  // status moved from the one at call time; answered and unanswered are final
  readonly readMessage: (messageID: MessageID, waitMs: number) => Promise<MessageView | null>;

  // A tap attached here replaces the session's previous tap, which learns
  // its subscription is over.
  readonly attachTap: (
    client: TapClient,
    sessionID: SessionID,
    access: TargetAccess | null,
    notices: boolean,
  ) => 'ok' | 'missing' | 'unsupported';

  readonly detachTap: (client: TapClient, sessionID: SessionID) => void;

  // Under an access, only a message sent to this atc id is the session's
  // to ack, as with the inbox drain.
  readonly ackMessage: (
    client: TapClient,
    sessionID: SessionID,
    messageID: MessageID,
    access: TargetAccess | null,
  ) => Promise<MessageRecord | 'not_tapping' | 'unknown'>;

  readonly ackNotice: (
    client: TapClient,
    sessionID: SessionID,
    messageID: MessageID,
  ) => Promise<MessageRecord | 'not_tapping' | 'unknown'>;
}

export function createMessageService(deps: MessageServiceDeps): MessageService {
  const manager = deps.manager;
  const store = deps.store;
  const clock = deps.clock;
  const ledger = deps.ledger;
  const taps = deps.taps;
  const findRuntime = deps.findRuntime;
  const eventSignal = deps.eventSignal;
  const emitEvent = deps.emitEvent;
  const findHookScope = deps.findHookScope;
  const isProcessEnded = deps.isProcessEnded;
  const tapGraceMs = deps.tapGraceMs;

  // Writes queued messages one at a time so the store's insertion order is
  // the order of their sent times, which the inbox drains by.
  let lastMessageWrite: Promise<void> = Promise.resolve();

  const inboxSource: InboxSource = {
    taps: deps.taps,
    findLinkedOwner: (sessionID) => {
      const session = manager.sessions.find((x) => x.id === sessionID);

      return session === undefined ? null : buildMessageOwner(session);
    },
    readPendingMessages: (owner) => store.readPendingMessages(owner),
    readPendingNotices: (senderSession) => store.readPendingNotices(senderSession),
  };

  const recordTrailEntry = async (entry: TrailEntry): Promise<boolean> => {
    let written: boolean;

    try {
      written = await store.recordTrailEntry(entry);
    } catch {
      return false;
    }

    if (written) {
      eventSignal.emit();
    }

    return written;
  };

  const recordMessageStatus = async (sessionID: SessionID, record: MessageRecord) => {
    const session = manager.sessions.find((x) => x.id === sessionID);

    await recordTrailEntry(buildMessageTrailEntry(sessionID, session?.agentSessionID, record));

    emitEvent(buildSessionMessageEvent(sessionID, record), findHookScope(sessionID));
  };

  const markMessageDelivered = async (
    sessionID: SessionID,
    messageID: MessageID,
    owner: MessageOwner,
  ): Promise<MessageRecord | null> => {
    const session = manager.sessions.find((x) => x.id === sessionID);

    const delivered = await store.updateMessageDelivered(messageID, owner, clock.now(), (record) =>
      buildMessageTrailEntry(sessionID, session?.agentSessionID, record),
    );

    if (delivered !== null) {
      eventSignal.emit();

      emitEvent(buildSessionMessageEvent(sessionID, delivered), findHookScope(sessionID));
    }

    return delivered;
  };

  const recordNoticeStatus = async (
    record: MessageRecord,
    kind: 'notice-queued' | 'notice-delivered',
  ): Promise<void> => {
    if (record.senderSession === undefined) {
      return;
    }

    const sender = manager.sessions.find((x) => x.id === record.senderSession);

    await recordTrailEntry(
      buildNoticeTrailEntry(record.senderSession, sender?.agentSessionID, record, kind),
    );
  };

  const drainSessionInbox = (sessionID: SessionID): Promise<void> =>
    drainInbox(sessionID, inboxSource);

  const recordAnswerNotice = async (record: MessageRecord): Promise<void> => {
    if (record.senderSession === undefined || record.noticeQueuedAt === undefined) {
      return;
    }

    try {
      await recordNoticeStatus(record, 'notice-queued');

      void drainSessionInbox(record.senderSession);
    } catch {}
  };

  const updateEndedMessages = async (
    sessionID: SessionID,
    owner: MessageOwner,
    gone = false,
  ): Promise<void> => {
    try {
      const at = clock.now();

      const unanswered = gone
        ? await store.updateUnsettledMessagesUnanswered(owner, 'session_ended', at)
        : await store.updateDeliveredMessagesUnanswered(owner, 'session_ended', at);

      for (const record of unanswered) {
        await recordMessageStatus(sessionID, record);
        await recordAnswerNotice(record);
      }
    } catch {}
  };

  const updateEndedSessionMessages = async (session: Session, gone = false): Promise<void> => {
    const shared =
      session.agentSessionID !== undefined &&
      manager.sessions.some(
        (x) =>
          x.id !== session.id &&
          x.agentSessionID === session.agentSessionID &&
          (x.pty !== null || (x.kind === 'headless' && x.state !== 'exited')),
      );

    if (!shared) {
      await updateEndedMessages(session.id, buildMessageOwner(session), gone);
    }
  };

  // Why the session refuses a message right now, or null when it takes one.
  const findMessageRefusal = (sessionID: SessionID): MessageRefusal | null => {
    const session = manager.sessions.find((x) => x.id === sessionID);

    if (session === undefined) {
      return 'missing';
    }

    if (!(session.pty !== null || (session.kind === 'headless' && session.state !== 'exited'))) {
      return 'dead';
    }

    if (manager.findAdapter(session.agent)?.takesMessages !== true) {
      return 'unsupported';
    }

    const runtime = findRuntime(sessionID);

    if (
      runtime !== undefined &&
      runtime.startedAt !== null &&
      !runtime.tapAttached &&
      clock.now() - runtime.startedAt >= tapGraceMs
    ) {
      return 'no_tap';
    }

    return null;
  };

  // a caller outside a session that takes messages, or whose tree is out of reach, gets no
  // notice and reads the answer with message.get
  const findNoticeSender = (
    callerSession: SessionID | null,
    access: TargetAccess | null,
  ): SessionID | null => {
    if (callerSession === null) {
      return null;
    }

    const session = manager.sessions.find((x) => x.id === callerSession);

    if (session === undefined || manager.findAdapter(session.agent)?.takesMessages !== true) {
      return null;
    }

    if (access !== null && !isTreeInReach(manager.sessions, session.id, access)) {
      return null;
    }

    return session.id;
  };

  // only the write itself can reject: every later step swallows its own failure, so a rejection
  // means nothing was written; the caller's check runs again once earlier writes land
  const writeQueuedMessage = async (
    sessionID: SessionID,
    caller: MessageCaller,
    text: string,
    id: MessageID,
    requireWriteInReach: () => void,
    senderSession: SessionID | null,
  ): Promise<MessageRecord> => {
    const session = manager.sessions.find((x) => x.id === sessionID);
    const previousWrite = lastMessageWrite;
    const written = Promise.withResolvers<void>();

    lastMessageWrite = written.promise;

    await previousWrite;

    // A session sender's name is the one it holds as its message is written.
    const sender = buildMessageSender(caller, manager.sessions);

    const record: MessageRecord = {
      id,
      atcID: sessionID,
      ...(session?.agentSessionID === undefined ? {} : { agentSessionID: session.agentSessionID }),
      from: sender.name,
      sender,
      text,
      status: 'queued',
      sentAt: clock.now(),
      ...(senderSession === null ? {} : { senderSession }),
    };

    try {
      // The write boundary: the reach check and the start of the row write
      // run in one synchronous step, so no wait lets the session's tree
      // leave the access between the check and the write it allows.
      requireWriteInReach();

      await store.writeMessage(record);

      await recordMessageStatus(sessionID, record);
    } finally {
      written.resolve();
    }

    await drainSessionInbox(sessionID);

    return record;
  };

  // A retried send answers with the message's current status, so a caller
  // that lost the first answer learns where its message stands now.
  const loadMessageReplay = async (
    record: IdempotencyRecord,
  ): Promise<DaemonAnswer<'session.message'>> => {
    const current = await store.readMessageByID(toMessageID(record.effectRef));

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
  };

  // A message belongs to the live session holding its atc id, else to the
  // one holding its agent session id, else to the atc id it was sent to.
  const readMessageView = async (messageID: MessageID): Promise<MessageView | null> => {
    const record = await store.readMessageByID(messageID);

    if (record === null) {
      return null;
    }

    const owner =
      manager.sessions.find((x) => x.id === record.atcID) ??
      manager.sessions.find(
        (x) => record.agentSessionID !== undefined && x.agentSessionID === record.agentSessionID,
      );

    return {
      session: owner?.id ?? record.atcID,
      record,
      answeredWith: await store.readTurnSiblings(record),
    };
  };

  return {
    recordTrailEntry,

    recordMessageStatus,

    markMessageDelivered,

    recordNoticeStatus,

    recordAnswerNotice,

    drainSessionInbox,

    updateEndedMessages,

    updateEndedSessionMessages,

    writeSessionMessage: async (sessionID, caller, text, keyed, access, callerSession) => {
      const requireInReach = () => {
        if (access !== null && !isTreeInReach(manager.sessions, sessionID, access)) {
          throw new MessageRefusedError('missing');
        }
      };

      const senderSession = findNoticeSender(callerSession, access);

      try {
        if (keyed === null) {
          const refusal = findMessageRefusal(sessionID);

          if (refusal !== null) {
            return refusal;
          }

          const record = await writeQueuedMessage(
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

        return await ledger.run({
          operation: 'session.message',
          keyed,
          effectRef,
          start: async () => {
            requireInReach();

            const refusal = findMessageRefusal(sessionID);

            if (refusal !== null) {
              throw new MessageRefusedError(refusal);
            }

            const record = await writeQueuedMessage(
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
          replay: (record) => loadMessageReplay(record),
        });
      } catch (error) {
        if (error instanceof MessageRefusedError) {
          return error.refusal;
        }

        throw error;
      }
    },

    readMessage: async (messageID, waitMs) => {
      const deadline = clock.now() + waitMs;
      let initialStatus: MessageStatus | null = null;

      for (;;) {
        const generation = eventSignal.generation;

        const view = await readMessageView(messageID);

        if (view === null) {
          return null;
        }

        initialStatus ??= view.record.status;

        const remaining = deadline - clock.now();

        if (
          view.record.status !== initialStatus ||
          view.record.status === 'answered' ||
          view.record.status === 'unanswered' ||
          remaining <= 0 ||
          eventSignal.disposed
        ) {
          return view;
        }

        await eventSignal.waitForNext(generation, remaining);
      }
    },

    attachTap: (client, sessionID, access, notices) => {
      const session = manager.sessions.find((x) => x.id === sessionID);

      if (session === undefined) {
        return 'missing';
      }

      if (manager.findAdapter(session.agent)?.takesMessages !== true) {
        return 'unsupported';
      }

      emitInboxClosed(
        taps.attach(sessionID, client, access === null, notices),
        sessionID,
        'replaced',
      );

      const runtime = findRuntime(sessionID);

      if (runtime !== undefined) {
        runtime.tapAttached = true;
      }

      void drainSessionInbox(sessionID);

      return 'ok';
    },

    detachTap: (client, sessionID) => {
      if (taps.isTap(sessionID, client)) {
        taps.removeSession(sessionID);
      }
    },

    ackMessage: async (client, sessionID, messageID, access) => {
      const session = manager.sessions.find((x) => x.id === sessionID);

      if (session === undefined || !taps.isTap(sessionID, client)) {
        return 'not_tapping';
      }

      const owner = access === null ? buildMessageOwner(session) : { atcID: session.id };

      const delivered = await markMessageDelivered(sessionID, messageID, owner);

      void drainSessionInbox(sessionID);

      if (delivered !== null) {
        // a tap can outlive its process, so an ack can land after the end marked its messages; a
        // process is surely gone once its exit was seen or a local session has no terminal, while a
        // remote host that lost the connection or went to sleep may still run it
        const live =
          session.pty !== null || (session.kind === 'headless' && session.state !== 'exited');

        if (!live && (isProcessEnded(session.id) || manager.isLocalTarget(session.target))) {
          await updateEndedSessionMessages(session);

          const settled = await store.readMessage(messageID, owner);

          return settled ?? delivered;
        }

        return delivered;
      }

      const current = await store.readMessage(messageID, owner);

      return current ?? 'unknown';
    },

    ackNotice: async (client, sessionID, messageID) => {
      if (!manager.sessions.some((x) => x.id === sessionID) || !taps.isTap(sessionID, client)) {
        return 'not_tapping';
      }

      const delivered = await store.updateNoticeDelivered(messageID, sessionID, clock.now());

      void drainSessionInbox(sessionID);

      if (delivered !== null) {
        await recordNoticeStatus(delivered, 'notice-delivered');

        return delivered;
      }

      const current = await store.readMessageByID(messageID);

      return current?.senderSession === sessionID && current.noticeQueuedAt !== undefined
        ? current
        : 'unknown';
    },
  };
}
