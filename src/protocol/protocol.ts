import { isRecord } from '../shared/report';

/**
 * The daemon/client wire dialect: NDJSON over a unix socket, one JSON object
 * per line. Three message kinds, distinguished by which fields are present —
 * request (id + m), response (id + ok or err), event (ev).
 */
export const PROTOCOL_V = 2;

// Control lines are capped before buffering; PTY output is split into chunks
// so a queued response is delayed by at most one chunk.
export const MAX_LINE = 1_048_576;
export const MAX_CHUNK = 65_536;

const ERROR_CODES = [
  'protocol_mismatch',
  'unauthorized',
  'unknown_method',
  'bad_args',
  'no_such_session',
  'session_dead',
  'unsupported',
  'already_answered',
  'too_slow',
  'internal',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

interface ProtocolError {
  readonly code: ErrorCode;
  readonly msg: string;
}

export interface RequestMsg {
  readonly v: number;
  readonly id: number;
  readonly m: string;
  readonly p?: Readonly<Record<string, unknown>>;
}

export interface ResponseMsg {
  readonly v: number;
  readonly id: number;
  readonly ok?: Readonly<Record<string, unknown>>;
  readonly err?: ProtocolError;
}

export interface EventMsg {
  readonly v: number;
  readonly ev: string;
  readonly [field: string]: unknown;
}

export type DecodedMsg =
  | { readonly kind: 'request'; readonly msg: RequestMsg }
  | { readonly kind: 'response'; readonly msg: ResponseMsg }
  | { readonly kind: 'event'; readonly msg: EventMsg }
  | { readonly kind: 'malformed'; readonly reason: string };

/**
 * Classifies one NDJSON line. Unknown fields pass through untouched so
 * additive evolution never breaks a peer; a line that parses but fits no
 * message kind is malformed, and the caller closes the connection.
 */
export function decodeMessage(line: string): DecodedMsg {
  let parsed: unknown;

  try {
    parsed = JSON.parse(line);
  } catch {
    return { kind: 'malformed', reason: 'not valid JSON' };
  }

  if (!isRecord(parsed) || typeof parsed['v'] !== 'number') {
    return { kind: 'malformed', reason: 'missing v' };
  }

  if (typeof parsed['ev'] === 'string') {
    return { kind: 'event', msg: { ...parsed, v: parsed['v'], ev: parsed['ev'] } };
  }

  if (typeof parsed['id'] !== 'number') {
    return { kind: 'malformed', reason: 'missing id' };
  }

  if (typeof parsed['m'] === 'string') {
    const p = parsed['p'];

    return {
      kind: 'request',
      msg: {
        v: parsed['v'],
        id: parsed['id'],
        m: parsed['m'],
        ...(isRecord(p) ? { p } : {}),
      },
    };
  }

  const ok = parsed['ok'];
  const err = parsed['err'];

  if (isRecord(ok) || isProtocolError(err)) {
    return {
      kind: 'response',
      msg: {
        v: parsed['v'],
        id: parsed['id'],
        ...(isRecord(ok) ? { ok } : {}),
        ...(isProtocolError(err) ? { err } : {}),
      },
    };
  }

  return { kind: 'malformed', reason: 'no m, ok, or err' };
}

export function encodeMessage(msg: EventMsg | RequestMsg | ResponseMsg): string {
  return `${JSON.stringify(msg)}\n`;
}

function isProtocolError(value: unknown): value is ProtocolError {
  return (
    isRecord(value) &&
    typeof value['msg'] === 'string' &&
    ERROR_CODES.some((code) => code === value['code'])
  );
}
