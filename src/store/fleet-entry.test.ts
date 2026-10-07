import { expect, test } from 'bun:test';
import { toAgentSessionID } from '../shared/to-agent-session-id';
import { parseFleetEntry } from './fleet-entry';

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

test('it parses a parent agent session id into a branded id', () => {
  expect(
    parseFleetEntry({ name: 'worker', cwd: '/repo', agentSessionID: 'c-2', parent: 'c-1' }),
  ).toStrictEqual({
    name: 'worker',
    cwd: '/repo',
    agentSessionID: toAgentSessionID('c-2'),
    agent: 'claude',
    parent: toAgentSessionID('c-1'),
  });
});

test('it omits parent when the row carries an empty one', () => {
  expect(
    parseFleetEntry({ name: 'worker', cwd: '/repo', agentSessionID: 'c-2', parent: '' }),
  ).toStrictEqual({
    name: 'worker',
    cwd: '/repo',
    agentSessionID: toAgentSessionID('c-2'),
    agent: 'claude',
  });
});

test('it leaves out the pinned flag, last-attached time, and exited flag when the row does not carry them', () => {
  expect(
    parseFleetEntry({ name: 'fix the bug', cwd: '/repo', agentSessionID: 'c-1' }),
  ).toStrictEqual({
    name: 'fix the bug',
    cwd: '/repo',
    agentSessionID: toAgentSessionID('c-1'),
    agent: 'claude',
  });
});

test('it reads the legacy claude id key of an old fleet file as the agent session id', () => {
  expect(
    parseFleetEntry({ name: 'fix the bug', cwd: '/repo', claudeId: 'legacy-1' }),
  ).toStrictEqual({
    name: 'fix the bug',
    cwd: '/repo',
    agentSessionID: toAgentSessionID('legacy-1'),
    agent: 'claude',
  });
});

test('it prefers the agent session id key over the legacy claude id key of a fleet file', () => {
  expect(
    parseFleetEntry({
      name: 'fix the bug',
      cwd: '/repo',
      agentSessionID: 'current-1',
      claudeId: 'legacy-1',
    }),
  ).toStrictEqual({
    name: 'fix the bug',
    cwd: '/repo',
    agentSessionID: toAgentSessionID('current-1'),
    agent: 'claude',
  });
});

test.each([
  [null],
  [undefined],
  ['garbage'],
  [42],
  [[]],
  [{ cwd: '/repo', agentSessionID: 'c-1' }],
  [{ name: 'fix the bug', agentSessionID: 'c-1' }],
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
