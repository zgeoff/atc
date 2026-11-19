import { z } from 'zod';
import { IDEMPOTENCY_KEY_FIELD } from './parse-idempotency-key';
import { TOOL_ANNOTATIONS } from './tool-annotations';
import type { MCPToolDefinition } from './types';
import { WAIT_MS } from './wait-ms';

// The key as a plain JSON Schema property, for an input schema written out
// by hand.
const { $schema: _, ...IDEMPOTENCY_KEY_INPUT } = z.toJSONSchema(IDEMPOTENCY_KEY_FIELD, {
  io: 'input',
});

const MESSAGE_GET_INPUT: Readonly<Record<string, unknown>> = z.toJSONSchema(
  z.strictObject({
    message: z.string().describe('The message id atc_message_send returned'),
    waitMs: WAIT_MS.describe(
      'How long to hold the call until the message status changes from what it was when you called, in milliseconds; defaults to 0, capped at 30000',
    ),
  }),
  { io: 'input' },
);

// Output schemas leave further properties open, so a field the daemon adds
// later never fails a client that validates results against them.
const MESSAGE_OUTPUT: Readonly<Record<string, unknown>> = {
  type: 'object',
  properties: {
    message: { type: 'string', description: 'the message id' },
    session: { type: 'string', description: 'the atc session id the message went to' },
    from: {
      type: 'string',
      description:
        "The sender's name, the same as sender.name; on a message stored before atc labelled senders, the name its sender gave",
    },
    sender: {
      type: 'object',
      description:
        "Who sent the message, as atc labelled it from the caller; no caller sets it. kind is connector (a remote client, its OAuth client id in client and its client name in name), session (an atc session, its id in session and the name it had when it sent in name), or owner (the user's own atc command line, name owner); a later daemon may add a kind. Absent on a message stored before atc labelled senders",
      properties: {
        kind: { type: 'string' },
        name: { type: 'string' },
        client: { type: 'string' },
        session: { type: 'string' },
      },
    },
    text: { type: 'string', description: 'the text that was sent' },
    status: {
      type: 'string',
      description:
        'queued (waiting in the inbox), delivered (handed to the session), answered, or unanswered (the turn that carried the message ended without an answer, or the process of the session ended while the message was delivered); a later daemon may add a value',
    },
    answer: {
      type: 'string',
      description:
        'the text the session sent with the answer tool or, if none, the final reply of the turn that answered the message, cut at 64 KiB; present only on an answered message',
    },
    turn: {
      type: ['string', 'null'],
      description:
        "the id of the agent's turn whose final reply answered the message or that ended without an answer; null for an answer sent with the answer tool, and while atc holds none",
    },
    answeredWith: {
      type: 'array',
      items: { type: 'string' },
      description:
        'the ids of the other messages to the same session that the same turn answered and the caller can see; this message is never among them',
    },
    sentAt: { type: 'number', description: 'when atc queued the message, in epoch milliseconds' },
    deliveredAt: {
      type: 'number',
      description: 'when atc handed the message to the session, in epoch milliseconds',
    },
    answeredAt: {
      type: 'number',
      description: 'when atc stored the answer, in epoch milliseconds',
    },
    unansweredAt: {
      type: 'number',
      description: 'When atc marked the message unanswered; present only on an unanswered message',
    },
    unansweredReason: {
      type: 'string',
      description:
        'Why the turn ended without an answer: interrupted (a person stopped the turn), error (the turn failed), refusal (the model declined), not_started (the prompt never started a turn), or session_ended (the process of the session ended before the turn did); present only on an unanswered message',
    },
  },
  required: ['message', 'session', 'from', 'text', 'status', 'turn', 'answeredWith', 'sentAt'],
};

const MESSAGE_SENT_OUTPUT: Readonly<Record<string, unknown>> = {
  type: 'object',
  properties: {
    message: { type: 'string', description: 'the message id, for atc_message_get' },
    status: {
      type: 'string',
      description:
        'queued (waiting in the inbox), delivered (handed to the session), answered, or unanswered (the turn that carried the message ended without an answer, or the process of the session ended while the message was delivered); a later daemon may add a value',
    },
  },
  required: ['message', 'status'],
};

export const MESSAGE_TOOLS: readonly MCPToolDefinition[] = [
  {
    name: 'atc_message_send',
    annotations: TOOL_ANNOTATIONS.agentFacing,
    scope: 'message',
    description:
      "Send a message to a session's agent and get its id back. The message goes into the agent's conversation, never into the terminal, and the agent's answer is stored on the message. Sent from inside an atc session that takes messages, the outcome also reaches your own conversation by itself as an <atc-answer id=\"...\" status=\"answered|unanswered\"> notice once the message is answered or unanswered; it needs no reply and no atc_message_get call. A caller with no inbox (outside a session, a remote client, or a session whose agent takes no messages) follows with atc_message_get and waitMs until status is answered or unanswered. status is queued (waiting in atc's inbox), delivered (handed to the session, not yet confirmed as seen by the model), answered, or unanswered: the turn that carried the message ended without an answer (interrupted, an error, a refusal, or the prompt never started a turn) or the session's process ended while atc held the message delivered, with the cause in unansweredReason. A message still queued when the process ends stays queued for the session's next process. A message to a session that waits for its restore after a daemon restart queues the same way, and atc hands it to the session's message bridge once the bridge attaches. unanswered is final: atc never delivers the message again, so send it again to retry. The answer is the text the session sent with the answer tool or, if none, the final reply of the turn that carried the message; messages that one final reply answered share it, and answeredWith in atc_message_get lists the others. Refused: unsupported when the agent takes no messages (capabilities.message false in atc_spawn_options_get), or when its message bridge has not attached 15 seconds after the session started; session_dead when the session's state is exited in atc_sessions_list, an asleep session included: start it again with atc_session_adopt, then send; no_such_session for an unknown id. The call cannot say who the message is from: atc labels it with the caller, a remote client by its client name, a session by its session id and name, and any other caller as the owner, and the receiving agent sees that label. A retry with the same idempotencyKey and text returns the same message with its current status. A refused send leaves no key on the daemon, so send it again under a new key: under the gateway, a retry with the same key returns outcome_unknown and sends nothing.",
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'The atc session id, from atc_sessions_list' },
        text: { type: 'string', description: 'The message text' },
        idempotencyKey: IDEMPOTENCY_KEY_INPUT,
      },
      required: ['session', 'text'],
      additionalProperties: false,
    },
    outputSchema: MESSAGE_SENT_OUTPUT,
  },
  {
    name: 'atc_message_get',
    annotations: TOOL_ANNOTATIONS.readOnly,
    scope: 'read',
    description:
      'Read one message sent with atc_message_send. A sender inside an atc session that takes messages gets the outcome as an <atc-answer> notice. Every other caller has no inbox, so this read is how it learns the outcome: a caller outside a session, a remote client, or a session whose agent takes no messages (capabilities.message false in atc_spawn_options_get). A caller may also use it to wait on one message. It returns the message with its status (queued, delivered, answered or unanswered), the answer once answered and unansweredReason once unanswered; the output schema holds the meaning of each field. unanswered means the turn that carried the message ended without an answer, or the process of its session ended while the message was delivered (unansweredReason session_ended), and is final: atc never delivers the message again, so send it again to retry. The answer is the text the session sent with the answer tool or, if none, the final reply of the turn that carried the message; messages that one final reply answered share it, and answeredWith lists the others. Pass waitMs, up to 30000, to hold the call until the status changes; an answered or unanswered message returns at once. Ids and statuses persist, so call again after a timeout. An unknown id, or one whose session the caller cannot see, is refused with bad_args.',
    inputSchema: MESSAGE_GET_INPUT,
    outputSchema: MESSAGE_OUTPUT,
  },
];
