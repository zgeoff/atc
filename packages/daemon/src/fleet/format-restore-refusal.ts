import type { SessionID } from '@atcx/contract';

// The parts of a daemon refusal the reason is built from.
interface Refusal {
  readonly code: string;
  readonly message: string;
  readonly data: Readonly<Record<string, unknown>> | undefined;
}

export function formatRestoreRefusal(id: SessionID, refusal: Refusal): string {
  const hint = pickRefusalHint(id, refusal);

  return hint === null ? refusal.message : `${refusal.message}. ${hint}`;
}

// a changed auth selection or a blocked binding clears with a rebind, a dropped
// auth block once the block is back, and a launch a rebind overtook as it is
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
