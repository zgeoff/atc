import { expect, test } from 'bun:test';
import { isOwnHookEvent } from './is-own-hook-event';

test.each([
  { agent: 'claude', sessionAgent: 'claude', hasAgentHookLines: false, isOwn: true },
  { agent: 'claude', sessionAgent: 'claude', hasAgentHookLines: true, isOwn: true },
  { agent: 'codex', sessionAgent: 'claude', hasAgentHookLines: false, isOwn: false },
  { agent: 'codex', sessionAgent: 'claude', hasAgentHookLines: true, isOwn: false },
  { agent: 'claude', sessionAgent: 'zai', hasAgentHookLines: true, isOwn: false },
  { agent: undefined, sessionAgent: 'claude', hasAgentHookLines: false, isOwn: true },
  { agent: undefined, sessionAgent: 'claude', hasAgentHookLines: true, isOwn: false },
])(
  'it judges a line from $agent at a $sessionAgent session with agent lines seen $hasAgentHookLines as own: $isOwn',
  (row) => {
    expect(isOwnHookEvent(row.agent, row.sessionAgent, row.hasAgentHookLines)).toBe(row.isOwn);
  },
);
