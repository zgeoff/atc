import type { AgentID } from '../agents/agent-adapter';

const BUILT_IN_MARKS: Readonly<Record<AgentID, string>> = { grok: 'g', codex: 'x' };

/**
 * The reserved overlay column after unread: one character per agent, a space
 * for Claude, so session names stay aligned across a mixed fleet. A
 * configured mark wins, so a backend added by the user gets its own letter.
 */
export function formatOverlayAgentMark(
  agent: AgentID,
  marks: Readonly<Record<AgentID, string>> = {},
): string {
  return marks[agent] ?? BUILT_IN_MARKS[agent] ?? ' ';
}
