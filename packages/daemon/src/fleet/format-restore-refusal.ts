import type { SessionID } from '@atc/core';

// The parts of a daemon refusal the reason is built from.
interface Refusal {
  readonly code: string;
  readonly message: string;
  readonly data: Readonly<Record<string, unknown>> | undefined;
}

/**
 * The reason a session lists after its restore was refused: the refusal's
 * own message, followed by the commands and MCP tools that clear it when
 * the refusal is one a rebind or a later adopt clears. Any other refusal
 * keeps its message alone.
 */
export function formatRestoreRefusal(id: SessionID, refusal: Refusal): string {
  const hint = pickRefusalHint(id, refusal);

  return hint === null ? refusal.message : `${refusal.message}. ${hint}`;
}

// A host whose auth selection changed, or whose binding a revoke or a
// failed rebind blocked, launches again after a rebind; a host whose agent
// dropped its auth block launches again once the block is back; a launch
// that a rebind overtook runs again as it is.
function pickRefusalHint(id: SessionID, refusal: Refusal): string | null {
  const problem = refusal.data?.['problem'];
  const state = refusal.data?.['state'];
  const adopt = `atc session adopt ${id} (MCP: atc_session_adopt)`;

  if (
    (refusal.code === 'auth_rebind_required' && problem === 'auth_selection_changed') ||
    (refusal.code === 'auth_blocked' && (state === 'revoked' || state === 'rebind_failed'))
  ) {
    return `Fix: atc session rebind ${id} (MCP: atc_session_auth_rebind), then ${adopt}`;
  }

  if (refusal.code === 'auth_rebind_required' && problem === 'auth_dropped') {
    return `Once the auth block is back: ${adopt}`;
  }

  if (refusal.code === 'auth_rebind_required' && problem === 'revision_moved') {
    return `Try again: ${adopt}`;
  }

  return null;
}
