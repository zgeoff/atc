import type { DaemonAnswer, RequestParams } from '@atc/protocol';
import { DaemonError } from '@atc/protocol/wire';
import type { DaemonContext } from '../daemon-context';
import type { MessageCaller } from '../sessions/message-caller';
import { buildKeyedRequest } from './build-keyed-request';
import type { RequestDeps, RequestPrincipal } from './request-deps';

// The requests that send messages between sessions and take them from a
// session's inbox.
export interface MessageRequests {
  readonly applySessionMessage: (
    data: RequestParams<'session.message'>,
    ctx: DaemonContext,
    as: RequestPrincipal | null,
  ) => Promise<DaemonAnswer<'session.message'>>;

  readonly applyTap: (
    data: RequestParams<'session.tap'>,
    ctx: DaemonContext,
  ) => DaemonAnswer<'session.tap'>;

  readonly applyMessageGet: (
    data: RequestParams<'message.get'>,
    ctx: DaemonContext,
  ) => Promise<DaemonAnswer<'message.get'>>;

  readonly applyMessageAck: (
    data: RequestParams<'message.ack'>,
    ctx: DaemonContext,
  ) => Promise<DaemonAnswer<'message.ack'>>;

  readonly applyNoticeAck: (
    data: RequestParams<'notice.ack'>,
    ctx: DaemonContext,
  ) => Promise<DaemonAnswer<'notice.ack'>>;
}

export function buildMessageRequests(deps: RequestDeps): MessageRequests {
  const client = deps.client;
  const identity = deps.identity;

  // The kernel's session wins over any principal a request gives. A local name is the only
  // part of the request's params that labels the message, and never changes the kind.
  const findMessageCaller = (
    as: RequestPrincipal | null,
    localName: string | undefined,
  ): MessageCaller => {
    if (identity.peerSession !== null) {
      return { kind: 'session', session: identity.peerSession };
    }

    if (as !== null) {
      return { kind: 'connector', client: as.principal, name: as.name ?? as.principal };
    }

    if (identity.principal !== null) {
      return { kind: 'connector', client: identity.principal, name: identity.principal };
    }

    if (identity.callerSession !== null) {
      return { kind: 'session', session: identity.callerSession };
    }

    if (isAtcClient(identity.helloClient)) {
      return { kind: 'owner' };
    }

    return { kind: 'local', name: localName ?? identity.helloClient };
  };

  return {
    applySessionMessage: async (data, ctx, as) => {
      const sessionID = data.session;

      if (data.replayOnly === true && data.idempotencyKey === undefined) {
        throw new DaemonError('bad_args', 'replayOnly needs an idempotencyKey');
      }

      // The hash leaves out a local caller's name, which only labels the
      // message, so a retry under another name replays the same send.
      const { from: localName, ...hashed } = data;
      const keyed = buildKeyedRequest(hashed);

      // A send that needs no answer leaves no session to notify.
      const noticeSession = data.notice === false ? null : identity.callerSession;

      const result = await ctx.writeSessionMessage(
        sessionID,
        findMessageCaller(as, localName),
        data.text,
        keyed,
        null,
        noticeSession,
      );

      if (result === 'missing' || !ctx.isSessionVisible(sessionID)) {
        throw new DaemonError('no_such_session', `no session '${sessionID}'`);
      }

      if (result === 'dead') {
        throw new DaemonError('session_dead', `session '${sessionID}' has no live process`);
      }

      if (result === 'unsupported') {
        throw new DaemonError(
          'unsupported',
          `session '${sessionID}' cannot take messages: its agent has no message tap`,
        );
      }

      if (result === 'no_tap') {
        throw new DaemonError('unsupported', `session '${sessionID}' never attached a message tap`);
      }

      return result;
    },

    applyTap: (data, ctx) => {
      const sessionID = data.session;
      const result = ctx.attachTap(client, sessionID, null, data.notices);

      if (result === 'missing') {
        throw new DaemonError('no_such_session', `no session '${sessionID}'`);
      }

      if (result === 'unsupported') {
        throw new DaemonError('unsupported', `session '${sessionID}' cannot take messages`);
      }

      return {};
    },

    applyMessageGet: async (data, ctx) => {
      const messageID = data.message;

      const view = await ctx.readMessage(messageID, data.waitMs);

      if (view === null || !ctx.isSessionVisible(view.session)) {
        throw new DaemonError('bad_args', `no message '${messageID}'`);
      }

      const record = view.record;

      // A message the turn also answered is listed only while the session it
      // was sent to is in view, checked in the step that sends.
      const answeredWith = view.answeredWith
        .filter((sibling) => ctx.isSessionVisible(sibling.atcID))
        .map((sibling) => sibling.id);

      return {
        message: record.id,
        session: view.session,
        from: record.from,
        ...(record.sender === undefined ? {} : { sender: record.sender }),
        text: record.text,
        status: record.status,
        sentAt: record.sentAt,
        ...(record.deliveredAt === undefined ? {} : { deliveredAt: record.deliveredAt }),
        ...(record.answeredAt === undefined ? {} : { answeredAt: record.answeredAt }),
        ...(record.answer === undefined ? {} : { answer: record.answer }),
        ...(record.unansweredAt === undefined ? {} : { unansweredAt: record.unansweredAt }),
        ...(record.unansweredReason === undefined
          ? {}
          : { unansweredReason: record.unansweredReason }),
        turn: record.turn ?? null,
        answeredWith,
      };
    },

    applyMessageAck: async (data, ctx) => {
      const sessionID = data.session;
      const messageID = data.message;

      const result = await ctx.ackMessage(client, sessionID, messageID, null);

      if (result === 'not_tapping') {
        throw new DaemonError('bad_args', `this connection is not tapping session '${sessionID}'`);
      }

      if (result === 'unknown' || !ctx.isSessionVisible(sessionID)) {
        throw new DaemonError('bad_args', `no message '${messageID}' for session '${sessionID}'`);
      }

      return { message: result.id, status: result.status };
    },

    applyNoticeAck: async (data, ctx) => {
      const sessionID = data.session;
      const messageID = data.message;

      const result = await ctx.ackNotice(client, sessionID, messageID);

      if (result === 'not_tapping') {
        throw new DaemonError('bad_args', `this connection is not tapping session '${sessionID}'`);
      }

      if (result === 'unknown' || !ctx.isSessionVisible(sessionID)) {
        throw new DaemonError(
          'bad_args',
          `no answer notice of message '${messageID}' for session '${sessionID}'`,
        );
      }

      return { message: result.id, status: result.status };
    },
  };
}

// The client name every atc client gives in its handshake: the atc build,
// `atc/` and its version.
const ATC_CLIENT_PREFIX = 'atc/';

function isAtcClient(client: string): boolean {
  return client.startsWith(ATC_CLIENT_PREFIX);
}
