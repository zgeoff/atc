import { expect, test } from 'bun:test';
import { parseFleetEntry } from './fleet-entry';
import { toAgentSessionID } from './to-agent-session-id';

test('it parses a well-formed row into a fleet entry', () => {
  expect(
    parseFleetEntry({
      name: 'fix the bug',
      cwd: '/repo',
      agentSessionID: 'c-1',
      agent: 'codex',
      pinned: true,
      lastAttachedAt: 100,
      exited: true,
    }),
  ).toStrictEqual({
    name: 'fix the bug',
    cwd: '/repo',
    agentSessionID: toAgentSessionID('c-1'),
    agent: 'codex',
    pinned: true,
    lastAttachedAt: 100,
    exited: true,
  });
});

test('it omits pinned, lastAttachedAt, and exited when the row does not carry them', () => {
  expect(
    parseFleetEntry({ name: 'fix the bug', cwd: '/repo', agentSessionID: 'c-1' }),
  ).toStrictEqual({
    name: 'fix the bug',
    cwd: '/repo',
    agentSessionID: toAgentSessionID('c-1'),
    agent: 'claude',
  });
});

test('it falls back to the legacy claudeId key when agentSessionID is absent', () => {
  expect(
    parseFleetEntry({ name: 'fix the bug', cwd: '/repo', claudeId: 'legacy-1' }),
  ).toStrictEqual({
    name: 'fix the bug',
    cwd: '/repo',
    agentSessionID: toAgentSessionID('legacy-1'),
    agent: 'claude',
  });
});

test('it prefers agentSessionID over a legacy claudeId when both are present', () => {
  expect(
    parseFleetEntry({
      name: 'fix the bug',
      cwd: '/repo',
      agentSessionID: 'current-1',
      claudeId: 'legacy-1',
    })?.agentSessionID,
  ).toBe(toAgentSessionID('current-1'));
});

test.each([
  [null],
  [undefined],
  ['garbage'],
  [42],
  [[]],
  [{}],
  [{ name: 'fix the bug', cwd: '/repo' }],
  [{ name: 42, cwd: '/repo', agentSessionID: 'c-1' }],
  [{ name: 'fix the bug', cwd: null, agentSessionID: 'c-1' }],
  [{ name: 'fix the bug', cwd: '/repo', agentSessionID: 42 }],
])('it reads %p as an unusable row instead of throwing', (raw) => {
  expect(parseFleetEntry(raw)).toBeUndefined();
});

test('it treats wrong-typed optional fields as absent instead of throwing', () => {
  expect(
    parseFleetEntry({
      name: 'fix the bug',
      cwd: '/repo',
      agentSessionID: 'c-1',
      pinned: 'yes',
      lastAttachedAt: 'never',
      exited: 1,
    }),
  ).toStrictEqual({
    name: 'fix the bug',
    cwd: '/repo',
    agentSessionID: toAgentSessionID('c-1'),
    agent: 'claude',
  });
});
