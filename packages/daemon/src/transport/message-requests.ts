import { parseRequestParams } from '@atc/protocol';
import type { RequestMsg } from '@atc/protocol/wire';
import type { DaemonContext, TapClient } from '../daemon-context';
import type { MessageCaller } from '../sessions/message-caller';
import { buildKeyedRequest } from './build-keyed-request';
import { buildLegacyMessageHashes } from './build-legacy-message-hashes';
import type { ConnectionReply } from './connection-reply';
import type { ConnectionIdentity, RequestDeps } from './request-deps';

// The requests that send messages between sessions and take them from a
// session's inbox.
export class MessageRequests {
  private readonly client: TapClient;

  private readonly reply: ConnectionReply;

  private readonly identity: ConnectionIdentity;

  constructor(deps: RequestDeps) {
    this.client = deps.client;
    this.reply = deps.reply;
    this.identity = deps.identity;
  }

  async applySessionMessage(req: RequestMsg, ctx: DaemonContext): Promise<void> {
    const parsed = parseRequestParams('session.message', req.p);

    if (!parsed.ok) {
      this.reply.sendErr(req.id, 'bad_args', parsed.message);

      return;
    }

    const sessionID = parsed.data.session;

    if (parsed.data.replayOnly === true && parsed.data.idempotencyKey === undefined) {
      this.reply.sendErr(req.id, 'bad_args', 'replayOnly needs an idempotencyKey');

      return;
    }

    // The hash leaves out a local caller's name, as a daemon that ignored it
    // stored it, so a retry across an upgrade replays.
    const { from: localName, ...hashed } = parsed.data;
    const keyed = buildKeyedRequest(hashed);

    // An older client's default sender names, so a key an older daemon
    // stored with one still replays.
    const legacyNames = ['mcp', req.asName, this.identity.callerSession];

    const legacyKeyed =
      keyed === null
        ? null
        : {
            ...keyed,
            legacyPayloadHashes: buildLegacyMessageHashes(hashed, req.p?.['from'], legacyNames),
          };

    // A send that needs no answer leaves no session to notify.
    const noticeSession = parsed.data.notice === false ? null : this.identity.callerSession;

    const result = await ctx.writeSessionMessage(
      sessionID,
      this.findMessageCaller(req, localName),
      parsed.data.text,
      legacyKeyed,
      null,
      noticeSession,
    );

    if (result === 'missing' || !ctx.isSessionVisible(sessionID)) {
      this.reply.sendErr(req.id, 'no_such_session', `no session '${sessionID}'`);

      return;
    }

    if (result === 'dead') {
      this.reply.sendErr(req.id, 'session_dead', `session '${sessionID}' has no live process`);

      return;
    }

    if (result === 'unsupported') {
      this.reply.sendErr(
        req.id,
        'unsupported',
        `session '${sessionID}' cannot take messages: its agent has no message tap`,
      );

      return;
    }

    if (result === 'no_tap') {
      this.reply.sendErr(
        req.id,
        'unsupported',
        `session '${sessionID}' never attached a message tap`,
      );

      return;
    }

    this.reply.sendOk(req.id, 'session.message', result);
  }

  // The kernel's session wins over any principal a request gives. A local name is the only
  // part of the request's params that labels the message, and never changes the kind.
  private findMessageCaller(req: RequestMsg, localName: string | undefined): MessageCaller {
    if (this.identity.peerSession !== null) {
      return { kind: 'session', session: this.identity.peerSession };
    }

    if (req.as !== undefined) {
      return { kind: 'connector', client: req.as, name: req.asName ?? req.as };
    }

    if (this.identity.principal !== null) {
      return { kind: 'connector', client: this.identity.principal, name: this.identity.principal };
    }

    if (this.identity.callerSession !== null) {
      return { kind: 'session', session: this.identity.callerSession };
    }

    if (isAtcClient(this.identity.helloClient)) {
      return { kind: 'owner' };
    }

    return { kind: 'local', name: localName ?? this.identity.helloClient };
  }

  applyTap(req: RequestMsg, ctx: DaemonContext): void {
    const parsed = parseRequestParams('session.tap', req.p);

    if (!parsed.ok) {
      this.reply.sendErr(req.id, 'bad_args', parsed.message);

      return;
    }

    const sessionID = parsed.data.session;
    const result = ctx.attachTap(this.client, sessionID, null, parsed.data.notices);

    if (result === 'missing') {
      this.reply.sendErr(req.id, 'no_such_session', `no session '${sessionID}'`);

      return;
    }

    if (result === 'unsupported') {
      this.reply.sendErr(req.id, 'unsupported', `session '${sessionID}' cannot take messages`);

      return;
    }

    this.reply.sendOk(req.id, 'session.tap', {});
  }

  async applyMessageGet(req: RequestMsg, ctx: DaemonContext): Promise<void> {
    const parsed = parseRequestParams('message.get', req.p);

    if (!parsed.ok) {
      this.reply.sendErr(req.id, 'bad_args', parsed.message);

      return;
    }

    const messageID = parsed.data.message;

    const view = await ctx.readMessage(messageID, parsed.data.waitMs);

    if (view === null || !ctx.isSessionVisible(view.session)) {
      this.reply.sendErr(req.id, 'bad_args', `no message '${messageID}'`);

      return;
    }

    const record = view.record;

    // A message the turn also answered is listed only while the session it
    // was sent to is in view, checked in the step that sends.
    const answeredWith = view.answeredWith
      .filter((sibling) => ctx.isSessionVisible(sibling.atcID))
      .map((sibling) => sibling.id);

    this.reply.sendOk(req.id, 'message.get', {
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
    });
  }

  async applyMessageAck(req: RequestMsg, ctx: DaemonContext): Promise<void> {
    const parsed = parseRequestParams('message.ack', req.p);

    if (!parsed.ok) {
      this.reply.sendErr(req.id, 'bad_args', parsed.message);

      return;
    }

    const sessionID = parsed.data.session;
    const messageID = parsed.data.message;

    const result = await ctx.ackMessage(this.client, sessionID, messageID, null);

    if (result === 'not_tapping') {
      this.reply.sendErr(
        req.id,
        'bad_args',
        `this connection is not tapping session '${sessionID}'`,
      );

      return;
    }

    if (result === 'unknown' || !ctx.isSessionVisible(sessionID)) {
      this.reply.sendErr(
        req.id,
        'bad_args',
        `no message '${messageID}' for session '${sessionID}'`,
      );

      return;
    }

    this.reply.sendOk(req.id, 'message.ack', { message: result.id, status: result.status });
  }

  async applyNoticeAck(req: RequestMsg, ctx: DaemonContext): Promise<void> {
    const parsed = parseRequestParams('notice.ack', req.p);

    if (!parsed.ok) {
      this.reply.sendErr(req.id, 'bad_args', parsed.message);

      return;
    }

    const sessionID = parsed.data.session;
    const messageID = parsed.data.message;

    const result = await ctx.ackNotice(this.client, sessionID, messageID);

    if (result === 'not_tapping') {
      this.reply.sendErr(
        req.id,
        'bad_args',
        `this connection is not tapping session '${sessionID}'`,
      );

      return;
    }

    if (result === 'unknown' || !ctx.isSessionVisible(sessionID)) {
      this.reply.sendErr(
        req.id,
        'bad_args',
        `no answer notice of message '${messageID}' for session '${sessionID}'`,
      );

      return;
    }

    this.reply.sendOk(req.id, 'notice.ack', { message: result.id, status: result.status });
  }
}

// The client name every atc client gives in its handshake: the atc build,
// `atc/` and its version.
const ATC_CLIENT_PREFIX = 'atc/';

function isAtcClient(client: string): boolean {
  return client.startsWith(ATC_CLIENT_PREFIX);
}
