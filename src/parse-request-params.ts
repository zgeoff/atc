import { z } from 'zod';
import { isRecord } from './report';

export type RequestMethod = keyof typeof REQUEST_PARAM_SCHEMAS;

type RequestParams<M extends RequestMethod> = z.infer<(typeof REQUEST_PARAM_SCHEMAS)[M]>;

export type ParsedRequestParams<M extends RequestMethod> =
  | { readonly ok: true; readonly data: RequestParams<M> }
  | { readonly ok: false; readonly message: string };

/**
 * Validates and defaults one request's params against its method's schema.
 * A malformed shape folds into a single message the caller reports as
 * bad_args, instead of a thrown ZodError.
 */
export function parseRequestParams<M extends RequestMethod>(
  method: M,
  rawParams: unknown,
): ParsedRequestParams<M> {
  const input = isRecord(rawParams) ? rawParams : {};
  const result = REQUEST_PARAM_SCHEMAS[method].safeParse(input);

  if (!result.success) {
    return { ok: false, message: result.error.issues[0]?.message ?? 'invalid params' };
  }

  // oxlint-disable-next-line no-unsafe-type-assertion -- method narrows M, but TS can't follow that through an indexed lookup into the schema map; a successful safeParse against that same lookup guarantees the shape at runtime
  return { ok: true, data: result.data as RequestParams<M> };
}

/**
 * The session id shape callers outside the wire protocol require: present
 * and described for a tool-facing schema. Methods that tolerate an absent
 * session extend this with a defaulted field instead of restating it.
 */
export const SESSION_ID_BASE = z.object({
  session: z.string().describe('The atc session id, from atc_session_list'),
});

const EJECT_DEFAULT_PROMPT =
  'Continue the task autonomously. Verify your work as you go and stop when it is complete.';

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
    resume: buildDefaultedBooleanOrString(false),
    agent: z
      .string({ error: 'session.spawn agent must be a non-empty agent id' })
      .min(1, 'session.spawn agent must be a non-empty agent id')
      .optional(),
  }),
  'session.kill': SESSION_ID_BASE.extend({ session: buildDefaultedString('') }),
  'session.ack': SESSION_ID_BASE.extend({ session: buildDefaultedString('') }),
  'session.update': z.object({
    session: buildDefaultedString(''),
    name: buildOptionalString(),
    pinned: buildOptionalBoolean(),
  }),
  'session.attach': z.object({
    session: buildDefaultedString(''),
    cols: buildDefaultedNumber(80),
    rows: buildDefaultedNumber(24),
  }),
  'session.detach': z.object({ session: buildDefaultedString('') }),
  'session.input': z.object({
    session: buildDefaultedString(''),
    d: buildDefaultedString(''),
  }),
  'session.resize': z
    .object({
      session: buildDefaultedString(''),
      cols: buildDefaultedNumber(0),
      rows: buildDefaultedNumber(0),
    })
    .refine((v) => v.cols >= 1 && v.rows >= 1, {
      message: 'session.resize requires positive cols and rows',
    }),
  'session.resumeCommand': SESSION_ID_BASE.extend({ session: buildDefaultedString('') }),
  'session.eject': z.object({
    session: buildDefaultedString(''),
    prompt: buildDefaultedNonEmptyString(EJECT_DEFAULT_PROMPT),
  }),
  'session.adopt': z.object({
    session: buildDefaultedString(''),
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

// A value of the wrong type falls back to the default instead of failing
// the parse.
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
