import { z } from 'zod';
import { SESSION_ENTRY, SESSION_ENTRY_PROPERTIES, SESSION_RECORD } from './session-entry';
import { SESSION_ID_BASE, SESSION_INPUT } from './session-input';
import { TOOL_ANNOTATIONS } from './tool-annotations';
import type { MCPToolDefinition } from './types';
import { WAIT_MS } from './wait-ms';

const SESSION_READ_INPUT: Readonly<Record<string, unknown>> = z.toJSONSchema(
  SESSION_ID_BASE.extend({
    cursor: z
      .string()
      .optional()
      .describe(
        'The cursor a previous atc_transcript_read returned; omit to read from the start of the conversation',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe('Most rows to return; defaults to 50'),
  }).strict(),
  { io: 'input' },
);

const EVENTS_READ_INPUT: Readonly<Record<string, unknown>> = z.toJSONSchema(
  z.strictObject({
    session: z
      .string()
      .optional()
      .describe(
        "An atc session id; limits the read to that session's events. On one daemon a cursor stays valid across filtered and unfiltered reads; under the gateway a cursor holds only for the session filter it was read under, and another filter refuses it with bad_args",
      ),
    cursor: z
      .string()
      .optional()
      .describe(
        'The cursor a previous atc_events_read returned; omit to get the most recent events',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe('Most events to return; defaults to 50'),
    waitMs: WAIT_MS.describe(
      'How long to wait for a new event when none is pending, in milliseconds; defaults to 0, capped at 30000. Keep it short.',
    ),
    previewOnly: z
      .boolean()
      .optional()
      .describe(
        'true returns each note and each answer as its 600-character preview instead of its full text; defaults to false',
      ),
  }),
  { io: 'input' },
);

const EVENTS_OUTPUT: Readonly<Record<string, unknown>> = {
  type: 'object',
  properties: {
    events: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          cursor: {
            type: 'string',
            description: 'the cursor at this event; pass it to read on from after the event',
          },
          at: { type: 'number', description: 'when the event happened, in epoch milliseconds' },
          session: {
            type: 'string',
            description:
              'the atc session id the event belongs to; empty on a daemon-restarted event, which belongs to no session',
          },
          name: {
            type: ['string', 'null'],
            description: "the session's current name; null when atc no longer lists the session",
          },
          kind: {
            type: 'string',
            description: 'the event kind; the tool description lists them',
          },
          detail: {
            type: ['string', 'null'],
            description:
              "the event's detail, at most 600 characters; for a note or a message-answered event, the preview of its text or answer; null when the event has none",
          },
          message: {
            type: 'string',
            description: 'on a message or notice event, the message id, for atc_message_get',
          },
          label: { type: 'string', description: "on a note, the note's label" },
          result: {
            type: 'object',
            description:
              "on a daemon-restarted event, the restart's result: its exit code, the new daemon's pid and build, how many sessions it restored of how many, each failed session with its reason, the sessions it interrupted mid-turn, and the error that stopped it, or null",
          },
          text: {
            type: 'string',
            description:
              'on a note, the text atc stored; on a message-answered event, the answer atc stored; each cut at 64 KiB; absent with previewOnly or textError',
          },
          complete: {
            type: 'boolean',
            description:
              'false: atc kept only the preview of this note or answer, and text holds it. A text cut at 64 KiB reads true',
          },
          textError: {
            type: 'string',
            description:
              'the text of the note or answer did not load: its read failed, or the 10 seconds every text read on the page shares ran out; detail holds the preview',
          },
        },
        required: ['cursor', 'at', 'session', 'name', 'kind', 'detail'],
      },
    },
    cursor: {
      type: 'string',
      description: 'the cursor after the last event on the page; pass it on the next call',
    },
    more: {
      type: 'boolean',
      description:
        'true when events after this page wait to be read, so read again at once; a read without a cursor never counts the older events it skipped',
    },
    unavailable: {
      type: 'array',
      items: { type: 'string' },
      description:
        'under the gateway, daemons that did not answer; each keeps its place in the cursor',
    },
    started: {
      type: 'array',
      items: { type: 'string' },
      description:
        'under the gateway, daemons that joined the cursor on this call, read from their latest events',
    },
    truncated: {
      type: 'array',
      items: { type: 'string' },
      description: 'under the gateway, those of the started daemons with older events left unread',
    },
  },
  required: ['events', 'cursor', 'more'],
};

const SESSION_GET_ENTRY: Readonly<Record<string, unknown>> = {
  ...SESSION_ENTRY,
  description: 'the entry atc_sessions_list shows',
  properties: {
    ...SESSION_ENTRY_PROPERTIES,
    agentSessionID: {
      type: 'string',
      description:
        'the id the agent CLI gives the conversation, which resumes it; absent until the agent reports it',
    },
    lastAttachedAt: {
      type: 'number',
      description: 'when a terminal last attached to the session, in epoch milliseconds',
    },
    lifecycle: {
      type: 'object',
      description: "the wanted and actual state of the session's host, harness and attachment",
      properties: {
        desired: {
          type: 'string',
          description:
            'what the operator asked for: run, sleep or stop; a later daemon may add a value',
        },
        harness: {
          type: 'string',
          description:
            'the state of the agent process: running, suspended or exited; a later daemon may add a value',
        },
      },
    },
  },
};

const SESSION_GET_OUTPUT: Readonly<Record<string, unknown>> = {
  type: 'object',
  properties: {
    session: SESSION_GET_ENTRY,
    prompt: {
      type: ['string', 'null'],
      description: 'the prompt the session was spawned with; null without one',
    },
    lastActivityAt: {
      type: 'number',
      description:
        'when atc last recorded an event for the session, else when it was created, in epoch milliseconds',
    },
    pending: {
      type: ['object', 'null'],
      description:
        'while the session is needs_you, { message } with the agent\'s notification text, such as "Claude needs your permission"; never a menu\'s options; else null',
      properties: { message: { type: 'string' } },
    },
    result: {
      type: ['string', 'null'],
      description: 'the final reply of the latest finished turn; null before one',
    },
    sessionRecord: {
      ...SESSION_RECORD,
      type: ['object', 'null'],
      description: 'the scope atc recorded for the session; null when it holds none',
    },
  },
  required: ['session'],
};

const TRANSCRIPT_OUTPUT: Readonly<Record<string, unknown>> = {
  type: 'object',
  properties: {
    rows: {
      type: 'array',
      description: 'the messages on this page, oldest first',
      items: {
        type: 'object',
        properties: {
          role: { type: 'string', description: 'user or assistant' },
          text: { type: 'string', description: "the message's text" },
          tools: {
            type: 'array',
            description:
              'the tool uses in the message, each with its name and a summary of its input',
          },
          at: {
            type: ['number', 'null'],
            description:
              'when the message was written, in epoch milliseconds; null when the log holds no time',
          },
        },
      },
    },
    cursor: {
      type: 'string',
      description: 'the cursor after this page; pass it on the next call',
    },
    more: {
      type: 'boolean',
      description:
        'true when the page stopped at limit or at its size cap, even when the log ends there; false at the end of the log',
    },
  },
  required: ['rows', 'cursor'],
};

export const SESSION_READ_TOOLS: readonly MCPToolDefinition[] = [
  {
    name: 'atc_session_get',
    annotations: TOOL_ANNOTATIONS.readOnly,
    scope: 'read',
    description:
      "Read one session: its entry as atc_sessions_list shows it, the prompt it was spawned with, when atc last recorded activity for it, pending (an object with the agent's notification text while it is needs_you, such as \"Claude needs your permission\"; never a menu's options), result (the final reply of its latest finished turn) and sessionRecord (the scope atc recorded for it). atc_terminal_choose reads and answers a Claude Code menu, such as a permission prompt; a person answers any other agent's menu in the TUI. An unknown session, or one a remote client cannot reach, is refused with no_such_session.",
    inputSchema: SESSION_INPUT,
    outputSchema: SESSION_GET_OUTPUT,
  },
  {
    name: 'atc_transcript_read',
    annotations: TOOL_ANNOTATIONS.readOnly,
    scope: 'read',
    description:
      "Read a session's conversation log a page at a time, oldest first: user and assistant messages, with tool uses summarised. Pass the returned cursor to continue; more is true when the page stopped at limit or at its size cap, even when the log ends there, so a page with no rows ends the read. A cursor from before the session moved to a new log file reads the new log from its start. A line over 1 MiB is skipped. Claude and Claude-compatible agents only; other agents return unsupported, and an unknown session returns no_such_session.",
    inputSchema: SESSION_READ_INPUT,
    outputSchema: TRANSCRIPT_OUTPUT,
  },
  {
    name: 'atc_events_read',
    annotations: TOOL_ANNOTATIONS.readOnly,
    scope: 'read',
    description:
      "Read the fleet's event feed: the one call to catch up on session state changes, the notes sessions send, and the progress of messages you sent, oldest first. To wait on one message, use atc_message_get; for a session's conversation itself, use atc_transcript_read. It holds session events (started, prompt-submitted, needs-input, turn-done, ended), message events (message-queued, message-delivered, message-answered with the full answer, cut at 64 KiB, message-unanswered, each with the message id), answer notice events under the sending session (notice-queued, notice-delivered, with the message id), notes (note, with its label and full text, cut at 64 KiB) and daemon restarts (daemon-restarted, with the restart's result). Only a local caller reading the whole fleet gets daemon restarts: a remote client, a read under the gateway and a read limited to one session never do. Pass the returned cursor on the next call; more true means the page stopped early, so read again at once. Without a cursor it returns the latest events, and more never counts the older ones. waitMs holds the call until an event arrives, up to 30000; use it instead of polling. session limits the read to one session; previewOnly true returns 600-character previews of notes and answers instead. atc deletes events older than 30 days, except the newest event of each session. A partial read says so: complete false or textError on a note or an answer, and, under the gateway, unavailable, started or truncated, with their meanings in the output schema.",
    inputSchema: EVENTS_READ_INPUT,
    outputSchema: EVENTS_OUTPUT,
  },
];
