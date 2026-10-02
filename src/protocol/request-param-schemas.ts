import { z } from 'zod';
import { buildOptionalBoolean } from '../shared/build-optional-boolean';
import { buildOptionalString } from '../shared/build-optional-string';
import { toAgentSessionID } from '../shared/to-agent-session-id';
import { toMessageID } from '../shared/to-message-id';
import { toSessionID } from '../shared/to-session-id';

const EJECT_DEFAULT_PROMPT =
  'Continue the task autonomously. Verify your work as you go and stop when it is complete.';

// The `session` field every wire schema below carries: absent or
// wrong-typed falls back to an empty string instead of failing the parse.
// This is the one point where a session id arriving off the wire is typed
// as the branded atc session id every daemon-side session lookup expects.
const SESSION_DEFAULTED = z.object({
  session: buildDefaultedString('').transform(toSessionID),
});

export const REQUEST_PARAM_SCHEMAS = {
  'daemon.hello': z.object({
    client: buildDefaultedString('unknown client'),
  }),
  'daemon.ping': z.object({}),
  'daemon.quit': z.object({}),
  'session.list': z.object({}),
  'dirs.list': z.object({}),
  'fleet.list': z.object({}),
  'fleet.restore': z.object({
    cols: buildDefaultedNumber(80),
    rows: buildDefaultedNumber(24),
  }),
  'session.spawn': z.object({
    cwd: z.string({ error: 'session.spawn requires a cwd' }).min(1, 'session.spawn requires a cwd'),
    name: buildDefaultedString(''),
    prompt: buildDefaultedString(''),
    cols: buildDefaultedNumber(80),
    rows: buildDefaultedNumber(24),

    resume: buildDefaultedBooleanOrString(false).transform((v) =>
      typeof v === 'string' ? toAgentSessionID(v) : v,
    ),
    agent: z
      .string({ error: 'session.spawn agent must be a non-empty agent id' })
      .min(1, 'session.spawn agent must be a non-empty agent id')
      .optional(),

    // The session the new one is a sub-session of; absent or empty spawns a
    // top-level session.
    parent: z.preprocess(
      (v) => (typeof v === 'string' && v !== '' ? v : undefined),
      z.string().transform(toSessionID).optional(),
    ),
  }),
  'session.kill': SESSION_DEFAULTED,
  'session.ack': SESSION_DEFAULTED,
  'session.update': SESSION_DEFAULTED.extend({
    name: buildOptionalString(),
    pinned: buildOptionalBoolean(),
  }),
  'session.attach': SESSION_DEFAULTED.extend({
    cols: buildDefaultedNumber(80),
    rows: buildDefaultedNumber(24),
  }),
  'session.detach': SESSION_DEFAULTED,
  'session.input': SESSION_DEFAULTED.extend({
    d: buildDefaultedString(''),
  }),
  'session.resize': SESSION_DEFAULTED.extend({
    cols: buildDefaultedNumber(0),
    rows: buildDefaultedNumber(0),
  }).refine((v) => v.cols >= 1 && v.rows >= 1, {
    message: 'session.resize requires positive cols and rows',
  }),
  'session.resumeCommand': SESSION_DEFAULTED,
  'session.screen': SESSION_DEFAULTED,
  'session.eject': SESSION_DEFAULTED.extend({
    prompt: buildDefaultedNonEmptyString(EJECT_DEFAULT_PROMPT),
  }),
  'session.adopt': SESSION_DEFAULTED.extend({
    cols: buildDefaultedNumber(80),
    rows: buildDefaultedNumber(24),
  }),
  'permission.respond': z
    .object({
      request: buildDefaultedString(''),
      decision: buildDefaultedString(''),
    })
    .refine((v) => v.request !== '' && v.decision !== '', {
      message: 'permission.respond requires a request and a decision',
    }),
  'session.get': SESSION_DEFAULTED,
  'session.read': SESSION_DEFAULTED.extend({
    cursor: buildOptionalCursor(),
    limit: buildDefaultedNumber(50).transform((v) => Math.min(Math.max(Math.trunc(v), 1), 200)),
  }),
  'events.read': z.object({
    cursor: buildOptionalCursor(),
    limit: buildDefaultedNumber(50).transform((v) => Math.min(Math.max(Math.trunc(v), 1), 200)),
    waitMs: buildDefaultedNumber(0).transform((v) => Math.min(Math.max(Math.trunc(v), 0), 30_000)),
  }),
  'session.message': SESSION_DEFAULTED.extend({
    from: buildDefaultedNonEmptyString('unknown'),
    text: buildDefaultedString(''),
  }).refine((v) => v.text !== '', { message: 'session.message requires text' }),
  'session.tap': SESSION_DEFAULTED,
  'message.ack': SESSION_DEFAULTED.extend({
    message: buildDefaultedString('').transform(toMessageID),
  }).refine((v) => v.message !== '', { message: 'message.ack requires a message' }),
} as const;

function buildDefaultedString(fallback: string) {
  return z.preprocess((v) => (typeof v === 'string' ? v : undefined), z.string().default(fallback));
}

function buildDefaultedNumber(fallback: number) {
  return z.preprocess((v) => (typeof v === 'number' ? v : undefined), z.number().default(fallback));
}

function buildDefaultedBooleanOrString(fallback: boolean | string) {
  return z.preprocess(
    (v) => (typeof v === 'boolean' || typeof v === 'string' ? v : undefined),
    z.union([z.boolean(), z.string()]).default(fallback),
  );
}

// Absent or wrong-typed stays undefined rather than falling back to a
// value, so the caller can tell "not given" from "given" and skip an update.

// An explicit empty string also falls back to the default instead of
// standing as a deliberate empty value.
function buildDefaultedNonEmptyString(fallback: string) {
  return z.preprocess(
    (v) => (typeof v === 'string' && v !== '' ? v : undefined),
    z.string().default(fallback),
  );
}

// An empty cursor reads as no cursor, the way a client starting fresh sends it.
function buildOptionalCursor() {
  return z.preprocess(
    (v) => (typeof v === 'string' && v !== '' ? v : undefined),
    z.string().optional(),
  );
}
