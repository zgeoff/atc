import { z } from 'zod';
import { MESSAGE_STATUS_SCHEMA } from './message-status';
import { RESTART_RESULT_SCHEMA } from './restart-result';
import { SESSION_DESCRIPTOR_SCHEMA } from './session-descriptor';
import { MESSAGE_SENDER_SCHEMA } from './wire/message-sender';

const SESSION_EVENT = z.object({ session: SESSION_DESCRIPTOR_SCHEMA });

export const DAEMON_EVENT_SCHEMA = z.discriminatedUnion('ev', [
  SESSION_EVENT.extend({ ev: z.literal('SessionAdded') }),
  SESSION_EVENT.extend({ ev: z.literal('SessionState') }),
  SESSION_EVENT.extend({ ev: z.literal('SessionAttached') }),
  SESSION_EVENT.extend({ ev: z.literal('SessionDetached') }),
  z.object({
    ev: z.literal('SessionRenamed'),
    sessionID: z.string(),
    name: z.string(),
    namedBy: z.enum(['user', 'auto', 'agent']),
  }),
  z.object({ ev: z.literal('SessionRemoved'), sessionID: z.string() }),
  z.object({
    ev: z.literal('SessionResized'),
    sessionID: z.string(),
    cols: z.number(),
    rows: z.number(),
  }),
  z.object({
    ev: z.literal('SessionOutput'),
    sessionID: z.string(),
    seq: z.number(),
    data: z.string(),
  }),
  z.object({ ev: z.literal('SessionDesync'), sessionID: z.string(), dropped: z.number() }),
  z.object({
    ev: z.literal('PermissionRequested'),
    request: z.string(),
    sessionID: z.string(),
    message: z.string(),
    respondable: z.boolean(),
  }),
  z.object({ ev: z.literal('PermissionResolved'), request: z.string(), decision: z.string() }),
  z.object({
    ev: z.literal('SessionMessage'),
    sessionID: z.string(),
    message: z.string(),
    status: MESSAGE_STATUS_SCHEMA,
    from: z.string(),
    sender: MESSAGE_SENDER_SCHEMA.optional(),
    textPreview: z.string(),
    sentAt: z.number(),
    deliveredAt: z.number().optional(),
    answeredAt: z.number().optional(),
    answerPreview: z.string().optional(),
    unansweredAt: z.number().optional(),
    unansweredReason: z.string().optional(),
  }),
  z.object({
    ev: z.literal('SessionNote'),
    sessionID: z.string(),
    kind: z.string(),
    text: z.string(),
    sentAt: z.number(),
  }),
  z.object({
    ev: z.literal('InboxMessage'),
    sessionID: z.string(),
    message: z.string(),
    from: z.string(),
    sender: MESSAGE_SENDER_SCHEMA.optional(),
    text: z.string(),
    sentAt: z.number(),
  }),
  z.object({
    ev: z.literal('InboxNotice'),
    sessionID: z.string(),

    // The message the session sent, the session it was sent to, and how it
    // ended: answered with an answer, or unanswered with a reason.
    message: z.string(),
    from: z.string(),
    status: z.enum(['answered', 'unanswered']),
    answer: z.string().optional(),
    reason: z.string().optional(),
    at: z.number(),
  }),
  z.object({
    ev: z.literal('InboxClosed'),
    sessionID: z.string(),
    reason: z.enum(['replaced', 'removed']),
  }),
  z.object({ ev: z.literal('DaemonRestarted'), result: RESTART_RESULT_SCHEMA }),
]);

export type DaemonEvent = z.output<typeof DAEMON_EVENT_SCHEMA>;
