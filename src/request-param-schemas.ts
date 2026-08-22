import { z } from 'zod';
import type { AgentSessionID } from './agent-session-id';
import type { SessionID } from './session-id';

const EJECT_DEFAULT_PROMPT =
  'Continue the task autonomously. Verify your work as you go and stop when it is complete.';

// The `session` field every wire schema below carries: absent or
// wrong-typed falls back to an empty string instead of failing the parse.
// This is the one point where a session id arriving off the wire is typed
// as the branded atc session id every daemon-side session lookup expects.
const SESSION_DEFAULTED = z.object({
  // oxlint-disable-next-line no-unsafe-type-assertion -- the session field arrives off the wire as a plain string; this asserts its parsed type as the branded atc session id without adding a runtime step
  session: buildDefaultedString('') as unknown as z.ZodType<SessionID>,
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

    // oxlint-disable-next-line no-unsafe-type-assertion -- a string resume value arrives off the wire as an agent session id to resume; this asserts its parsed type into the branded agent session id without adding a runtime step
    resume: buildDefaultedBooleanOrString(false) as unknown as z.ZodType<boolean | AgentSessionID>,
    agent: z
      .string({ error: 'session.spawn agent must be a non-empty agent id' })
      .min(1, 'session.spawn agent must be a non-empty agent id')
      .optional(),
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
function buildOptionalString() {
  return z.preprocess((v) => (typeof v === 'string' ? v : undefined), z.string().optional());
}

function buildOptionalBoolean() {
  return z.preprocess((v) => (typeof v === 'boolean' ? v : undefined), z.boolean().optional());
}

// An explicit empty string also falls back to the default instead of
// standing as a deliberate empty value.
function buildDefaultedNonEmptyString(fallback: string) {
  return z.preprocess(
    (v) => (typeof v === 'string' && v !== '' ? v : undefined),
    z.string().default(fallback),
  );
}
