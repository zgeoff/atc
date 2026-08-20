import type { AgentKind } from './agent-adapter';

/**
 * The reserved overlay column after unread: a `g` for Grok, a space for
 * Claude, so session names stay aligned across a mixed fleet.
 */
export function formatOverlayAgentMark(agent: AgentKind): string {
  if (agent === 'grok') {
    return 'g';
  }

  if (agent === 'codex') {
    return 'x';
  }

  return ' ';
}
