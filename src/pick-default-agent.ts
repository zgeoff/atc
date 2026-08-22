import type { AgentKind } from './agent-adapter';
import type { AgentPick } from './collect-agent-picks';

/**
 * The choice the picker opens on: the last-used agent while it is installed,
 * otherwise the first installed one, so the common case costs no keystrokes.
 * With nothing installed the last-used agent stands and the picker refuses
 * it on select.
 */
export function pickDefaultAgent(picks: readonly AgentPick[], lastUsed: AgentKind): AgentKind {
  const preferred = picks.find((p) => p.agent === lastUsed);

  if (preferred !== undefined && preferred.binPath !== null) {
    return lastUsed;
  }

  return picks.find((p) => p.binPath !== null)?.agent ?? lastUsed;
}
