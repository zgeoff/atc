import { isRecord } from '@atc/core';
import { ERROR_CODES } from '@atcx/contract/light';
import type { ErrorCode } from '@atcx/contract/light';

// Raised by any change to a procedure, an input field, or an answer field,
// because a client trusts a daemon on its own version to serve its whole
// contract.
export const PROTOCOL_V = 12;

// Control lines are capped before buffering; PTY output is split into chunks
// so a queued response is delayed by at most one chunk.
export const MAX_LINE = 1_048_576;
export const MAX_CHUNK = 65_536;

interface ProtocolError {
  readonly code: ErrorCode;
  readonly message: string;

  // Structured detail an error code defines for itself.
  readonly data?: Readonly<Record<string, unknown>>;
}

export interface RequestMsg {
  readonly version: number;
  readonly id: number;
  readonly method: string;
  readonly params?: Readonly<Record<string, unknown>>;

  // The principal the request acts as, which narrows what the connection
  // may reach for this request alone.
  readonly as?: string;

  // The name of the principal in `as`, which the daemon labels a message
  // the request sends with; only ever beside `as`.
  readonly asName?: string;
}

export interface ResponseMsg {
  readonly version: number;
  readonly id: number;
  readonly ok?: Readonly<Record<string, unknown>>;
  readonly err?: ProtocolError;
}

export interface EventMsg {
  readonly version: number;
  readonly ev: string;
  readonly [field: string]: unknown;
}

export type DecodedMsg =
  | { readonly kind: 'request'; readonly message: RequestMsg }
  | { readonly kind: 'response'; readonly message: ResponseMsg }
  | { readonly kind: 'event'; readonly message: EventMsg }
  | { readonly kind: 'malformed'; readonly reason: string };

export function decodeMessage(line: string): DecodedMsg {
  let parsed: unknown;

  try {
    parsed = JSON.parse(line);
  } catch {
    return { kind: 'malformed', reason: 'not valid JSON' };
  }

  if (!isRecord(parsed) || typeof parsed['version'] !== 'number') {
    return { kind: 'malformed', reason: 'missing version' };
  }

  if (typeof parsed['ev'] === 'string') {
    return { kind: 'event', message: { ...parsed, version: parsed['version'], ev: parsed['ev'] } };
  }

  if (typeof parsed['id'] !== 'number') {
    return { kind: 'malformed', reason: 'missing id' };
  }

  if (typeof parsed['method'] === 'string') {
    const params = parsed['params'];
    const as = parsed['as'];

    // A principal that is not a string would otherwise drop out and leave the
    // request with the connection's whole reach.
    if (as !== undefined && (typeof as !== 'string' || as === '')) {
      return { kind: 'malformed', reason: 'as must be a non-empty string' };
    }

    const asName = parsed['asName'];

    if (asName !== undefined && (typeof asName !== 'string' || asName === '')) {
      return { kind: 'malformed', reason: 'asName must be a non-empty string' };
    }

    // A name without the principal it belongs to would label a message with
    // a name nobody vouched for.
    if (asName !== undefined && as === undefined) {
      return { kind: 'malformed', reason: 'asName needs as' };
    }

    return {
      kind: 'request',
      message: {
        version: parsed['version'],
        id: parsed['id'],
        method: parsed['method'],
        ...(isRecord(params) ? { params } : {}),
        ...(as === undefined ? {} : { as }),
        ...(asName === undefined ? {} : { asName }),
      },
    };
  }

  const ok = parsed['ok'];
  const err = parseProtocolError(parsed['err']);

  if (isRecord(ok) || err !== null) {
    return {
      kind: 'response',
      message: {
        version: parsed['version'],
        id: parsed['id'],
        ...(isRecord(ok) ? { ok } : {}),
        ...(err === null ? {} : { err }),
      },
    };
  }

  return { kind: 'malformed', reason: 'no method, ok, or err' };
}

export function encodeMessage(message: EventMsg | RequestMsg | ResponseMsg): string {
  return `${JSON.stringify(message)}\n`;
}

function parseProtocolError(value: unknown): ProtocolError | null {
  if (
    !isRecord(value) ||
    typeof value['message'] !== 'string' ||
    typeof value['code'] !== 'string'
  ) {
    return null;
  }

  const raw = value['code'];
  const data = value['data'];

  return {
    code: ERROR_CODES.find((code) => code === raw) ?? 'internal',
    message: value['message'],
    ...(isRecord(data) ? { data } : {}),
  };
}
