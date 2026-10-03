import { isRecord } from '../shared/report';

/**
 * The daemon/client wire dialect: NDJSON over a unix socket, one JSON object
 * per line. Three message kinds, distinguished by which fields are present —
 * request (id + m), response (id + ok or err), event (ev).
 */
export const PROTOCOL_V = 4;

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
  'unsupported_operation',
  'unknown_target',
  'target_unavailable',
  'target_changed',
  'target_config_invalid',
  'target_forbidden',
  'not_a_git_repo',
  'no_commits',
  'unreadable_tree',
  'has_submodules',
  'lfs_unsupported',
  'workspace_dirty',
  'no_origin',
  'invalid_git_url',
  'git_transports_invalid',
  'unpushed_head',
  'credential_in_url',
  'credential_missing',
  'ref_not_found',
  'clone_failed',
  'sanitize_failed',
  'tar_failed',
  'workspace_exists',
  'transfer_failed',
  'workspace_mismatch',
  'github_unavailable',
  'host_unavailable',
  'auth_not_configured',
  'auth_target_unsupported',
  'auth_impd_too_old',
  'auth_token_scope',
  'auth_token_too_broad',
  'auth_imp_out_of_scope',
  'auth_secret_not_grantable',
  'auth_secret_mismatch',
  'auth_runtime_mismatch',
  'auth_runtime_exists',
  'auth_grant_missing',
  'auth_grants_mismatch',
  'auth_rebind_required',
  'auth_blocked',
  'auth_binding_mismatch',
  'auth_binding_invalid',
  'auth_revocation_pending',
  'broker_not_ready',
  'host_leased',
  'confirmation_required',
  'confirm_token_invalid',
  'already_answered',
  'too_slow',
  'stale_epoch',
  'idempotency_conflict',
  'outcome_unknown',
  'idempotency_key_unknown',
  'internal',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

interface ProtocolError {
  readonly code: ErrorCode;
  readonly msg: string;

  // Structured detail an error code defines for itself.
  readonly data?: Readonly<Record<string, unknown>>;
}

export interface RequestMsg {
  readonly v: number;
  readonly id: number;
  readonly m: string;
  readonly p?: Readonly<Record<string, unknown>>;

  // The principal the request acts as, which narrows what the connection
  // may reach for this request alone.
  readonly as?: string;
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
 * message kind is malformed, and the caller closes the connection. An error
 * code this build does not know decodes as `internal` with its message
 * kept, so a peer that adds a code never breaks one that predates it.
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
    const as = parsed['as'];

    // A principal that is not a string would otherwise drop out and leave the
    // request with the connection's whole reach.
    if (as !== undefined && (typeof as !== 'string' || as === '')) {
      return { kind: 'malformed', reason: 'as must be a non-empty string' };
    }

    return {
      kind: 'request',
      msg: {
        v: parsed['v'],
        id: parsed['id'],
        m: parsed['m'],
        ...(isRecord(p) ? { p } : {}),
        ...(as === undefined ? {} : { as }),
      },
    };
  }

  const ok = parsed['ok'];
  const err = parseProtocolError(parsed['err']);

  if (isRecord(ok) || err !== null) {
    return {
      kind: 'response',
      msg: {
        v: parsed['v'],
        id: parsed['id'],
        ...(isRecord(ok) ? { ok } : {}),
        ...(err === null ? {} : { err }),
      },
    };
  }

  return { kind: 'malformed', reason: 'no m, ok, or err' };
}

export function encodeMessage(msg: EventMsg | RequestMsg | ResponseMsg): string {
  return `${JSON.stringify(msg)}\n`;
}

function parseProtocolError(value: unknown): ProtocolError | null {
  if (!isRecord(value) || typeof value['msg'] !== 'string' || typeof value['code'] !== 'string') {
    return null;
  }

  const raw = value['code'];
  const data = value['data'];

  return {
    code: ERROR_CODES.find((code) => code === raw) ?? 'internal',
    msg: value['msg'],
    ...(isRecord(data) ? { data } : {}),
  };
}
