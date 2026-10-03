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

// The idempotency key a spawn or message may carry, at most 200 characters.
const IDEMPOTENCY_KEY = z
  .string({ error: 'idempotencyKey must be a string' })
  .min(1, 'idempotencyKey must not be empty')
  .max(200, 'idempotencyKey must be at most 200 characters')
  .optional();

// A full commit id, SHA-1 or SHA-256.
const COMMIT_ID = /^(?:[\da-f]{40}|[\da-f]{64})$/u;

// The daemon environment variable a git workspace's token is read from.
const CREDENTIAL_REF = z.strictObject({
  kind: z.literal('env'),
  name: z.string().regex(/^[A-Za-z_]\w*$/u, 'a credentialRef names an environment variable'),
});

/**
 * Where a spawn's working directory comes from, materialized as a clean
 * checkout into the spawn's `cwd` on its execution target. A `path` source
 * is a directory on the daemon's host, resolved to its origin URL and
 * pushed HEAD; `allowDirty: 'warn'` resolves a tree with uncommitted
 * changes to HEAD and leaves the changes behind with a warning. A `git`
 * source is a repository URL with exactly one of a branch or tag `ref` or
 * a full commit `sha`, and an optional `credentialRef` naming the daemon
 * environment variable that holds its token.
 */
const WORKSPACE_SOURCE = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('path'),
    path: z
      .string({ error: 'a path workspace requires an absolute path' })
      .startsWith('/', 'a path workspace requires an absolute path'),
    allowDirty: z.enum(['refuse', 'warn']).optional(),
  }),
  z
    .strictObject({
      kind: z.literal('git'),
      url: z
        .string({ error: 'a git workspace requires a url' })
        .min(1, 'a git workspace requires a url')
        .refine((url) => !url.startsWith('-'), 'a git workspace url must not start with -'),
      ref: z
        .string()
        .min(1, 'a git workspace ref must not be empty')
        .refine((ref) => !ref.startsWith('-'), 'a git workspace ref must not start with -')
        .optional(),
      sha: z.string().regex(COMMIT_ID, 'a git workspace sha is a full commit id').optional(),
      credentialRef: CREDENTIAL_REF.optional(),
    })
    .refine((source) => (source.ref === undefined) !== (source.sha === undefined), {
      message: 'a git workspace takes exactly one of ref or sha',
    }),
]);

export type SpawnWorkspaceSource = z.infer<typeof WORKSPACE_SOURCE>;

// The refusal of a terminal size outside the range a terminal takes.
const TERMINAL_SIZE_ERROR = 'cols and rows must be whole numbers from 1 to 4096';

export const REQUEST_PARAM_SCHEMAS = {
  'daemon.hello': z.object({
    client: buildDefaultedString('unknown client'),
    principal: z
      .string({ error: 'daemon.hello principal must be a non-empty string' })
      .min(1, 'daemon.hello principal must be a non-empty string')
      .optional(),
  }),
  'daemon.ping': z.object({}),
  'daemon.quit': z.object({}),
  'session.list': z.object({}),
  'dirs.list': z.object({}),
  'agents.list': z.object({}),
  'fleet.list': z.object({}),
  'fleet.restore': z.object({
    cols: buildTerminalSize(80),
    rows: buildTerminalSize(24),
  }),
  'session.spawn': z.object({
    cwd: z.string({ error: 'session.spawn requires a cwd' }).min(1, 'session.spawn requires a cwd'),
    name: buildDefaultedString(''),
    prompt: buildDefaultedString(''),
    cols: buildTerminalSize(80),
    rows: buildTerminalSize(24),

    resume: buildDefaultedBooleanOrString(false).transform((v) =>
      typeof v === 'string' ? toAgentSessionID(v) : v,
    ),
    agent: z
      .string({ error: 'session.spawn agent must be a non-empty agent id' })
      .min(1, 'session.spawn agent must be a non-empty agent id')
      .optional(),

    // Per-session overrides; the daemon checks each against what the agent
    // advertises before anything spawns.
    model: z.string({ error: 'session.spawn model must be a string' }).optional(),
    effort: z.string({ error: 'session.spawn effort must be a string' }).optional(),

    // A retry carrying the same key replays the first spawn's answer instead
    // of spawning again.
    idempotencyKey: IDEMPOTENCY_KEY,

    // The execution target the session runs on; absent runs on the default
    // target, and a target the daemon cannot use refuses the spawn.
    target: z
      .string({ error: 'session.spawn target must be a non-empty target id' })
      .min(1, 'session.spawn target must be a non-empty target id')
      .optional(),

    // Where the session's working directory comes from: absent runs the
    // session in cwd as it stands, and a source materializes a clean
    // checkout into cwd first.
    workspace: WORKSPACE_SOURCE.optional(),

    // The session the new one is a sub-session of; absent or empty spawns a
    // top-level session.
    parent: z.preprocess(
      (v) => (typeof v === 'string' && v !== '' ? v : undefined),
      z.string().transform(toSessionID).optional(),
    ),
  }),
  'session.kill': SESSION_DEFAULTED,
  'session.ack': SESSION_DEFAULTED,

  // Without a token, a forget that destroys a host answers with one; the
  // forget that carries it destroys the host.
  'session.forget': SESSION_DEFAULTED.extend({
    confirmToken: z
      .string({ error: 'session.forget confirmToken must be a string' })
      .min(1, 'session.forget confirmToken must not be empty')
      .optional(),
  }),
  'session.update': SESSION_DEFAULTED.extend({
    name: buildOptionalString(),
    pinned: buildOptionalBoolean(),
  }),
  'session.attach': SESSION_DEFAULTED.extend({
    cols: buildTerminalSize(80),
    rows: buildTerminalSize(24),
  }),
  'session.detach': SESSION_DEFAULTED,
  'session.input': SESSION_DEFAULTED.extend({
    d: buildDefaultedString(''),
  }),
  'session.submit': SESSION_DEFAULTED.extend({
    text: buildDefaultedString(''),
  }),
  'session.resize': SESSION_DEFAULTED.extend({
    cols: buildTerminalSize(0),
    rows: buildTerminalSize(0),
  }).refine((v) => v.cols >= 1 && v.rows >= 1, {
    message: 'session.resize requires positive cols and rows',
  }),
  'session.resumeCommand': SESSION_DEFAULTED,
  'session.screen': SESSION_DEFAULTED,
  'session.eject': SESSION_DEFAULTED.extend({
    prompt: buildDefaultedNonEmptyString(EJECT_DEFAULT_PROMPT),
  }),
  'session.adopt': SESSION_DEFAULTED.extend({
    cols: buildTerminalSize(80),
    rows: buildTerminalSize(24),
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
    waitMs: buildDefaultedWait(),

    // Limits the read to one session's events; absent or empty reads the whole fleet.
    session: z.preprocess(
      (v) => (typeof v === 'string' && v !== '' ? v : undefined),
      z.string().transform(toSessionID).optional(),
    ),
  }),
  'session.message': SESSION_DEFAULTED.extend({
    from: buildDefaultedNonEmptyString('unknown'),
    text: buildDefaultedString(''),

    // A retry carrying the same key replays the first send's message
    // instead of sending another.
    idempotencyKey: IDEMPOTENCY_KEY,
  }).refine((v) => v.text !== '', { message: 'session.message requires text' }),
  'session.tap': SESSION_DEFAULTED,
  'message.get': z
    .object({
      message: buildDefaultedString('').transform(toMessageID),
      waitMs: buildDefaultedWait(),
    })
    .refine((v) => v.message !== '', { message: 'message.get requires a message' }),
  'report.get': z
    .object({
      // The cursor events.read returned with the report's event.
      report: buildDefaultedString(''),
    })
    .refine((v) => v.report !== '', { message: 'report.get requires a report' }),
  'message.ack': SESSION_DEFAULTED.extend({
    message: buildDefaultedString('').transform(toMessageID),
  }).refine((v) => v.message !== '', { message: 'message.ack requires a message' }),
} as const;

function buildDefaultedString(fallback: string) {
  return z.preprocess((v) => (typeof v === 'string' ? v : undefined), z.string().default(fallback));
}

// A terminal dimension: absent or not a number takes the fallback, and a
// number must be a whole number in range, since the terminal emulator and
// the PTY both assume one and a fractional size throws only after the
// process starts.
function buildTerminalSize(fallback: number) {
  return z.preprocess(
    (v) => (typeof v === 'number' ? v : undefined),
    z
      .number({ error: TERMINAL_SIZE_ERROR })
      .int(TERMINAL_SIZE_ERROR)
      .min(1, TERMINAL_SIZE_ERROR)
      .max(4096, TERMINAL_SIZE_ERROR)
      .default(fallback),
  );
}

function buildDefaultedNumber(fallback: number) {
  return z.preprocess((v) => (typeof v === 'number' ? v : undefined), z.number().default(fallback));
}

// How long a read may hold its request open, in milliseconds: 0 when absent,
// clamped to 0–30000.
function buildDefaultedWait() {
  return buildDefaultedNumber(0).transform((v) => Math.min(Math.max(Math.trunc(v), 0), 30_000));
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
