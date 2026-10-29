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
    { atcAccess: ['read'], resume: toAgentSessionID('conversation-own'), hasWorkspace: false },
  );

  expect(refusal).toBeNull();
});

test('it allows a spawn that grants nothing and resumes nothing', () => {
  const refusal = findGrantedSpawnRefusal(
    { id: toSessionID('holder'), scopes: ['spawn'], isResumable: () => false },
    { atcAccess: [], resume: false, hasWorkspace: false },
  );

  expect(refusal).toBeNull();
});

test.each<{
  label: string;
  atcAccess: readonly GrantScope[];
  resume: boolean | AgentSessionID;
  hasWorkspace: boolean;
  message: RegExp;
}>([
  {
    label: 'a scope the holder lacks',
    atcAccess: ['kill'],
    resume: false,
    hasWorkspace: false,
    message: /cannot grant kill/u,
  },
  {
    label: 'every scope when it holds one',
    atcAccess: ['read', 'message', 'spawn', 'kill'],
    resume: false,
    hasWorkspace: false,
    message: /cannot grant read, message, kill/u,
  },
  {
    label: 'a workspace source',
    atcAccess: [],
    resume: false,
    hasWorkspace: true,
    message: /takes no workspace source/u,
  },
  {
    label: 'the latest agent session',
    atcAccess: [],
    resume: true,
    hasWorkspace: false,
    message: /names the agent session to resume/u,
  },
  {
    label: 'an agent session out of reach',
    atcAccess: [],
    resume: toAgentSessionID('conversation-elsewhere'),
    hasWorkspace: false,
    message: /resumes only an agent session/u,
  },
  {
    label: 'an empty agent session id',
    atcAccess: [],
    resume: toAgentSessionID(''),
    hasWorkspace: false,
    message: /resumes only an agent session/u,
  },
])('it refuses a spawn that asks for $label', (row) => {
  const refusal = findGrantedSpawnRefusal(
    {
      id: toSessionID('holder'),
      scopes: ['spawn'],
      isResumable: (agentSessionID) => agentSessionID === toAgentSessionID('conversation-own'),
    },
    { atcAccess: row.atcAccess, resume: row.resume, hasWorkspace: row.hasWorkspace },
  );

  expect(refusal).toMatch(row.message);
});
