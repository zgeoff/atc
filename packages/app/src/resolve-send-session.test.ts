import { expect, test } from 'bun:test';
import { resolveSendSession } from './resolve-send-session';

test.each([
  { argument: 's-1', match: { kind: 'found', id: 's-1' } },
  { argument: 's-3', match: { kind: 'found', id: 's-3' } },
  { argument: 'Reviewer', match: { kind: 'found', id: 's-3' } },
  { argument: 'reviewer', match: { kind: 'missing' } },
  { argument: 'nobody', match: { kind: 'missing' } },
  {
    argument: 'planner',
    match: {
      kind: 'ambiguous',
      candidates: [
        { id: 's-1', name: 'planner', state: 'running' },
        { id: 's-2', name: 'planner', state: 'exited' },
      ],
    },
  },
])('it resolves $argument to $match', (row) => {
  const sessions = [
    { id: 's-1', name: 'planner', state: 'running' },
    { id: 's-2', name: 'planner', state: 'exited' },
    { id: 's-3', name: 'Reviewer', state: 'done' },
    { id: 's-4', name: 's-3', state: 'running' },
  ];

  expect(resolveSendSession(sessions, row.argument)).toStrictEqual(row.match);
});
