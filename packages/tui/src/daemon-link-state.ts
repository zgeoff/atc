import type { DaemonName } from './session-key';

export type DaemonLinkState =
  | { readonly kind: 'up' }

  // until the first handshake ends
  | { readonly kind: 'connecting' }

  // unreachable, or the connection dropped
  | { readonly kind: 'down'; readonly detail: string }

  // the token is missing or unreadable, or the daemon refused it or the principal
  | { readonly kind: 'unauthorized'; readonly detail: string }

  // the text of the daemon's protocol_mismatch refusal
  | { readonly kind: 'mismatched'; readonly detail: string };

// One line that names the daemon and where its link stands.
export function formatLinkState(daemon: DaemonName, state: DaemonLinkState): string {
  const name = daemon ?? 'local';

  return state.kind === 'up' || state.kind === 'connecting'
    ? `${name}: ${state.kind}`
    : `${name}: ${state.kind} — ${state.detail}`;
}
