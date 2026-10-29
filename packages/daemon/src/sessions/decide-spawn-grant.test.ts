import { expect, test } from 'bun:test';
import { toAgentID } from '@atc/core';
import { toSessionID } from '@atcx/contract';
import { decideSpawnGrant } from './decide-spawn-grant';

test('it grants the requested scopes to a remote session on a host of its own', () => {
  const decision = decideSpawnGrant({
    requested: ['read', 'spawn'],
    sessionID: toSessionID('new'),
    agent: toAgentID('claude'),
    target: 'box',
    isRemote: true,
    takesAtcMCP: true,
    hostKey: toSessionID('new'),
    hostAccess: [],
  });

  expect(decision).toStrictEqual({ kind: 'granted', atcAccess: ['read', 'spawn'] });
});

test('it grants a session that shares a host the scopes that host session holds', () => {
  const decision = decideSpawnGrant({
    requested: ['read'],
    sessionID: toSessionID('new'),
    agent: toAgentID('claude'),
    target: 'box',
    isRemote: true,
    takesAtcMCP: true,
    hostKey: toSessionID('host'),
    hostAccess: ['read', 'spawn'],
  });

  expect(decision).toStrictEqual({ kind: 'granted', atcAccess: ['read'] });
});

test.each([
  { label: 'no request', requested: undefined },
  { label: 'an empty request', requested: [] },
])('it grants no access for $label, wherever the session runs', (row) => {
  const decision = decideSpawnGrant({
    requested: row.requested,
    sessionID: toSessionID('new'),
    agent: toAgentID('codex'),
    target: 'local',
    isRemote: false,
    takesAtcMCP: false,
    hostKey: toSessionID('new'),
    hostAccess: [],
  });

  expect(decision).toStrictEqual({ kind: 'granted', atcAccess: null });
});

test.each([
  {
    label: 'a target on the daemon machine',
    isRemote: false,
    takesAtcMCP: true,
    hostKey: 'new',
    code: 'bad_args',
    message: /another machine/u,
  },
  {
    label: 'an agent that takes no atc MCP server',
    isRemote: true,
    takesAtcMCP: false,
    hostKey: 'new',
    code: 'bad_args',
    message: /takes no atc MCP server/u,
  },
  {
    label: 'a shared host whose session lacks the scope',
    isRemote: true,
    takesAtcMCP: true,
    hostKey: 'host',
    code: 'unauthorized',
    message: /lacks atc scope spawn/u,
  },
])('it refuses access on $label', (row) => {
  const decision = decideSpawnGrant({
    requested: ['read', 'spawn'],
    sessionID: toSessionID('new'),
    agent: toAgentID('claude'),
    target: 'box',
    isRemote: row.isRemote,
    takesAtcMCP: row.takesAtcMCP,
    hostKey: toSessionID(row.hostKey),
    hostAccess: ['read'],
  });

  expect(decision).toMatchObject({ kind: 'refused', code: row.code });
  expect(decision).toMatchObject({ message: expect.stringMatching(row.message) });
});
