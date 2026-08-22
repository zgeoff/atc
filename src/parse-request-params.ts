import { z } from 'zod';
import { isRecord } from './report';

const EJECT_DEFAULT_PROMPT =
  'Continue the task autonomously. Verify your work as you go and stop when it is complete.';

export type RequestMethod = keyof typeof REQUEST_PARAM_SCHEMAS;

export type RequestParams<M extends RequestMethod> = z.infer<(typeof REQUEST_PARAM_SCHEMAS)[M]>;

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

  // oxlint-disable-next-line no-unsafe-type-assertion -- method narrows M, but TS can't follow that through an indexed lookup into REQUEST_PARAM_SCHEMAS; a successful safeParse against that same lookup guarantees the shape at runtime
  return { ok: true, data: result.data as RequestParams<M> };
}

const REQUEST_PARAM_SCHEMAS = {
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
  'session.kill': z.object({ session: buildDefaultedString('') }),
  'session.ack': z.object({ session: buildDefaultedString('') }),
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
  'session.resumeCommand': z.object({ session: buildDefaultedString('') }),
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

// Any value of the wrong type falls back to the default instead of failing
// parse, matching the tolerant `typeof x === 'string' ? x : fallback` guards
// this schema module replaces.
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

// Like buildDefaultedString, but an explicit empty string also falls back
// to the default instead of standing as a deliberate empty value.
function buildDefaultedNonEmptyString(fallback: string) {
  return z.preprocess(
    (v) => (typeof v === 'string' && v !== '' ? v : undefined),
    z.string().default(fallback),
  );
}
