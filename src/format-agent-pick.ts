import type { AgentPick } from './collect-agent-picks';

/**
 * The menu row for one agent choice: an agent whose binary is missing stays
 * listed so the choice is discoverable, marked with why it cannot be picked.
 */
export function formatAgentPick(pick: AgentPick): string {
  return pick.binPath === null ? `${pick.label} — not installed` : pick.label;
}
