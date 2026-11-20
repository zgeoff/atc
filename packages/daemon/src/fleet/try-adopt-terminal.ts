import type { SessionID } from '@atcx/contract';
import { AtcError } from '@atcx/contract/light';
import type { ErrorCode } from '@atcx/contract/light';
import type { SessionManager } from '../sessions/create-session-manager';
import type { AdoptResult } from './types';

const REFUSED_ADOPT_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'unsupported_operation',
  'unknown_target',
  'target_unavailable',
  'target_changed',
  'target_config_invalid',
  'host_unavailable',
  'auth_not_configured',
  'auth_target_unsupported',
  'auth_token_scope',
  'auth_token_too_broad',
  'auth_host_out_of_scope',
  'auth_secret_not_grantable',
  'auth_secret_mismatch',
  'auth_runtime_mismatch',
  'auth_grant_missing',
  'auth_grants_mismatch',
  'auth_rebind_required',
  'auth_blocked',
  'auth_binding_invalid',
  'broker_not_ready',
  'auth_placeholder_unsupported',

  // The adopt call returns bad_args or unsupported when a plugin folder the session loads is
  // not a directory or is on a remote target.
  'bad_args',
  'unsupported',
]);

interface TryAdoptTerminalOptions {
  readonly id: SessionID;
  readonly cols: number;
  readonly rows: number;
  readonly canProceed: () => boolean;
}

export async function tryAdoptTerminal(
  manager: SessionManager,
  options: TryAdoptTerminalOptions,
): Promise<AdoptResult> {
  try {
    const session = await manager.adoptTerminal(
      options.id,
      options.cols,
      options.rows,
      options.canProceed,
    );

    return { kind: 'adopted', session };
  } catch (error) {
    if (error instanceof AtcError && REFUSED_ADOPT_CODES.has(error.code)) {
      return { kind: 'refused', refusal: error };
    }

    throw error;
  }
}
