import { expect, test } from 'bun:test';
import type { AgentSessionID, GrantScope } from '@atcx/contract';
import { toAgentSessionID, toSessionID } from '@atcx/contract';
import { findGrantedSpawnRefusal } from './find-granted-spawn-refusal';

test('it allows a spawn that grants held scopes and resumes an agent session in reach', () => {
  const refusal = findGrantedSpawnRefusal(
    {
      id: toSessionID('holder'),
      scopes: ['read', 'spawn'],
      isResumable: (agentSessionID) => agentSessionID === toAgentSessionID('conversation-own'),
    },
    { atcAccess: ['read'], resume: toAgentSessionID('conversation-own') },
  );

  expect(refusal).toBeNull();
});

test('it allows a spawn that grants nothing and resumes nothing', () => {
  const refusal = findGrantedSpawnRefusal(
    { id: toSessionID('holder'), scopes: ['spawn'], isResumable: () => false },
    { atcAccess: [], resume: false },
  );

  expect(refusal).toBeNull();
});

test.each<[string, readonly GrantScope[], boolean | AgentSessionID, RegExp]>([
  ['a scope the holder lacks', ['kill'], false, /cannot grant kill/u],
  [
    'every scope when it holds one',
    ['read', 'message', 'spawn', 'kill'],
    false,
    /cannot grant read, message, kill/u,
  ],
  ['the latest agent session', [], true, /names the agent session to resume/u],
  [
    'an agent session out of reach',
    [],
    toAgentSessionID('conversation-elsewhere'),
    /resumes only an agent session/u,
  ],
  ['an empty agent session id', [], toAgentSessionID(''), /resumes only an agent session/u],
])('it refuses a spawn that asks for %s', (_label, atcAccess, resume, message) => {
  const refusal = findGrantedSpawnRefusal(
    {
      id: toSessionID('holder'),
      scopes: ['spawn'],
      isResumable: (agentSessionID) => agentSessionID === toAgentSessionID('conversation-own'),
    },
    { atcAccess, resume },
  );

  expect(refusal).toMatch(message);
});
