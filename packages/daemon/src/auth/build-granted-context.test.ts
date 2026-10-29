import { expect, test } from 'bun:test';
import { buildMockSessionDescriptor } from '@atc/test-utils';
import type { AgentSessionID, GrantScope } from '@atcx/contract';
import { toAgentSessionID, toSessionID } from '@atcx/contract';
import { buildStubDaemonContext } from '../testing/build-stub-daemon-context';
import { buildGrantedContext } from './build-granted-context';

test('it passes a spawn that grants held scopes and resumes an agent session in the subtree', () => {
  const ctx = buildStubDaemonContext({
    collectSessions: () => [
      buildMockSessionDescriptor({
        id: toSessionID('child'),
        agentSessionID: toAgentSessionID('conversation-child'),
      }),
    ],
    collectSubtree: () => new Set([toSessionID('child')]),
  });

  const granted = buildGrantedContext(
    ctx,
    toSessionID('holder'),
    {
      scopes: ['read', 'spawn'],
      grant: { target: 'box', targetIdentity: 'remote:a' },
      parent: toSessionID('parent'),
      spawner: null,
    },
    'session.spawn',
  );

  expect(() => {
    granted.requireGrantedSpawn({
      atcAccess: ['read'],
      resume: toAgentSessionID('conversation-child'),
      hasWorkspace: false,
    });
  }).not.toThrow();
});

test.each<{
  label: string;
  held: readonly GrantScope[];
  atcAccess: readonly GrantScope[];
  resume: boolean | AgentSessionID;
  hasWorkspace: boolean;
}>([
  {
    label: 'a scope from a holder with none',
    held: [],
    atcAccess: ['read'],
    resume: false,
    hasWorkspace: false,
  },
  {
    label: 'more scopes than the holder holds',
    held: ['read', 'spawn'],
    atcAccess: ['read', 'kill'],
    resume: false,
    hasWorkspace: false,
  },
  {
    label: 'every scope from a holder with spawn alone',
    held: ['spawn'],
    atcAccess: ['read', 'message', 'spawn', 'kill'],
    resume: false,
    hasWorkspace: false,
  },
  {
    label: "a resume of the parent's agent session",
    held: ['spawn'],
    atcAccess: [],
    resume: toAgentSessionID('conversation-parent'),
    hasWorkspace: false,
  },
  {
    label: "a resume of a session's agent session outside the subtree",
    held: ['spawn'],
    atcAccess: [],
    resume: toAgentSessionID('conversation-stranger'),
    hasWorkspace: false,
  },
  {
    label: 'a resume of an agent session no session holds',
    held: ['spawn'],
    atcAccess: [],
    resume: toAgentSessionID('conversation-unknown'),
    hasWorkspace: false,
  },
  {
    label: 'a resume of the latest agent session',
    held: ['spawn'],
    atcAccess: [],
    resume: true,
    hasWorkspace: false,
  },
  {
    label: 'a workspace source',
    held: ['spawn'],
    atcAccess: [],
    resume: false,
    hasWorkspace: true,
  },
])('it refuses $label', (row) => {
  const ctx = buildStubDaemonContext({
    collectSessions: () => [
      buildMockSessionDescriptor({
        id: toSessionID('parent'),
        agentSessionID: toAgentSessionID('conversation-parent'),
      }),
      buildMockSessionDescriptor({
        id: toSessionID('child'),
        agentSessionID: toAgentSessionID('conversation-child'),
      }),
      buildMockSessionDescriptor({
        id: toSessionID('stranger'),
        agentSessionID: toAgentSessionID('conversation-stranger'),
      }),
    ],
    collectSubtree: () => new Set([toSessionID('child')]),
  });

  const granted = buildGrantedContext(
    ctx,
    toSessionID('holder'),
    {
      scopes: row.held,
      grant: { target: 'box', targetIdentity: 'remote:a' },
      parent: toSessionID('parent'),
      spawner: null,
    },
    'session.spawn',
  );

  expect(() => {
    granted.requireGrantedSpawn({
      atcAccess: row.atcAccess,
      resume: row.resume,
      hasWorkspace: row.hasWorkspace,
    });
  }).toThrow(expect.objectContaining({ code: 'unauthorized' }));
});

test.each([
  { label: 'another target', requested: 'local' },
  { label: 'a target that differs only in case', requested: 'Box' },
])("it refuses a spawn to $label than the holder's own", (row) => {
  const granted = buildGrantedContext(
    buildStubDaemonContext(),
    toSessionID('holder'),
    {
      scopes: ['spawn'],
      grant: { target: 'box', targetIdentity: 'remote:a' },
      parent: null,
      spawner: null,
    },
    'session.spawn',
  );

  expect(() => granted.resolveSpawnTarget(row.requested)).toThrow(
    expect.objectContaining({ code: 'target_forbidden' }),
  );
});
