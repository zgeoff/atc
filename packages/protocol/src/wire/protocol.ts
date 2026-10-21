import { isRecord } from '@atc/core';

// Raised by any change to a procedure, an input field, or an answer field,
// because a client trusts a daemon on its own version to serve its whole
// contract.
export const PROTOCOL_V = 10;

// Control lines are capped before buffering; PTY output is split into chunks
// so a queued response is delayed by at most one chunk.
export const MAX_LINE = 1_048_576;
export const MAX_CHUNK = 65_536;

export const ERROR_CODES = [
  'protocol_mismatch',
  'unauthorized',
  'unknown_method',
  'bad_args',
  'no_such_session',
  'session_dead',
  'permission_pending',
  'menu_changed',
  'menu_label_mismatch',
  'menu_busy',
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
  'git_output_open',
  'sanitize_failed',
  'tar_failed',
  'workspace_exists',
  'workspace_overlap',
  'transfer_failed',
  'workspace_mismatch',
  'scope_invalid',
  'github_unavailable',
  'host_unavailable',
  'auth_not_configured',
  'auth_target_unsupported',
  'auth_signin_needed',
  'auth_token_scope',
  'auth_token_too_broad',
  'auth_host_out_of_scope',
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
  'auth_placeholder_unsupported',
  'host_leased',
  'confirmation_required',
  'confirm_token_invalid',
  'session_pinned',
  'session_live',
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
