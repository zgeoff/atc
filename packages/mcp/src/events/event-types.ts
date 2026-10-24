// The event types a client may subscribe to, each fired by the event trail
// kind beside it. A delivery carries only the session id, because the
// subscriber reads what happened from the trail with atc_events_read.
export const EVENT_TYPES = [
  {
    name: 'session.needs_input',
    kind: 'needs-input',
    description:
      "Fires when a session's agent waits on the owner, such as at a permission prompt. Read what it waits on with atc_events_read from your last cursor.",
  },
  {
    name: 'session.turn_done',
    kind: 'turn-done',
    description:
      "Fires when a session's agent finishes a turn. Read its events with atc_events_read from your last cursor.",
  },
  {
    name: 'session.ended',
    kind: 'ended',
    description:
      'Fires when a session ends. Read its events with atc_events_read from your last cursor.',
  },
  {
    name: 'session.note',
    kind: 'note',
    description:
      'Fires when a session sends a note, such as a progress report or a request for a decision. Read the note with atc_events_read from your last cursor.',
  },
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

// The types take no arguments.
export const EVENT_INPUT_SCHEMA = {
  type: 'object',
  properties: {},
  additionalProperties: false,
} as const;

export const EVENT_PAYLOAD_SCHEMA = {
  type: 'object',
  properties: {
    session: {
      type: 'string',
      description: 'the atc session id the event belongs to',
    },
  },
  required: ['session'],
  additionalProperties: false,
} as const;
