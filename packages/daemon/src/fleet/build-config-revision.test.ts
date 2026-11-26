import { expect, test } from 'bun:test';
import { buildMockAgentAdapter } from '@atc/plugin-api/test-utils/build-mock-agent-adapter';
import { buildAgentList } from '../sessions/build-agent-list';
import { buildConfigRevision } from './build-config-revision';
import { buildExecutionTargets } from './build-execution-targets';

test('it builds the same revision for a fixed set of targets, agents and defaults', () => {
  const built = buildExecutionTargets(
    [
      { id: 'local', provider: 'local-pty', options: {} },
      {
        id: 'cloud',
        provider: 'imp',
        options: {
          url: 'http://impd.example:7070',
          tokenEnv: 'FIXTURE_IMP_TOKEN',
          image: 'atc-base',
        },
      },
    ],
    (config) => ({
      provider: null,
      problem: null,
      identityRule: new Map([
        [
          'imp',
          {
            version: 'reach-v1',
            ignoredOptions: ['image', 'memoryMib', 'guestATC', 'rebindChangedAuth'],
          },
        ],
      ]).get(config.provider),
    }),
  );

  expect(
    buildConfigRevision(built.targets, 'local', built.errors, {
      entries: [],
      defaultAgent: 'claude',
    }),
  ).toBe('991f957337cf2771');
});

test('it builds a sixteen-digit hex revision', () => {
  expect(
    buildConfigRevision(
      [{ id: 'local', kind: 'local-pty', options: {}, identity: 'local-pty:a', provider: null }],
      'local',
      [],
      { entries: [], defaultAgent: 'claude' },
    ),
  ).toMatch(/^[\da-f]{16}$/u);
});

test('it builds the same revision for the same targets, default, and errors', () => {
  expect(
    buildConfigRevision(
      [{ id: 'box', kind: 'imp', options: {}, identity: 'imp:a', provider: null }],
      'box',
      [{ scope: 'target', target: 'other', problem: 'bad' }],
      { entries: [], defaultAgent: 'claude' },
    ),
  ).toBe(
    buildConfigRevision(
      [{ id: 'box', kind: 'imp', options: {}, identity: 'imp:a', provider: null }],
      'box',
      [{ scope: 'target', target: 'other', problem: 'bad' }],
      { entries: [], defaultAgent: 'claude' },
    ),
  );
});

test('it builds another revision when a target identity changes', () => {
  expect(
    buildConfigRevision(
      [{ id: 'box', kind: 'imp', options: {}, identity: 'imp:a', provider: null }],
      'box',
      [],
      { entries: [], defaultAgent: 'claude' },
    ),
  ).not.toBe(
    buildConfigRevision(
      [{ id: 'box', kind: 'imp', options: {}, identity: 'imp:b', provider: null }],
      'box',
      [],
      { entries: [], defaultAgent: 'claude' },
    ),
  );
});

test('it builds another revision when the default target changes', () => {
  expect(
    buildConfigRevision(
      [{ id: 'box', kind: 'imp', options: {}, identity: 'imp:a', provider: null }],
      'box',
      [],
      { entries: [], defaultAgent: 'claude' },
    ),
  ).not.toBe(
    buildConfigRevision(
      [{ id: 'box', kind: 'imp', options: {}, identity: 'imp:a', provider: null }],
      null,
      [],
      { entries: [], defaultAgent: 'claude' },
    ),
  );
});

test('it builds another revision when the config errors change', () => {
  expect(
    buildConfigRevision(
      [{ id: 'box', kind: 'imp', options: {}, identity: 'imp:a', provider: null }],
      'box',
      [],
      { entries: [], defaultAgent: 'claude' },
    ),
  ).not.toBe(
    buildConfigRevision(
      [{ id: 'box', kind: 'imp', options: {}, identity: 'imp:a', provider: null }],
      'box',
      [{ scope: 'target', target: 'other', problem: 'bad' }],
      { entries: [], defaultAgent: 'claude' },
    ),
  );
});

test('it builds another revision when an agent entry is added', () => {
  const targets = [
    { id: 'box', kind: 'imp', options: {}, identity: 'imp:a', provider: null },
  ] as const;

  const agents = buildAgentList([buildMockAgentAdapter({ id: 'zai' })], () => true, []);

  expect(buildConfigRevision(targets, 'box', [], { entries: [], defaultAgent: 'claude' })).not.toBe(
    buildConfigRevision(targets, 'box', [], { entries: agents, defaultAgent: 'claude' }),
  );
});

test('it builds another revision when an agent entry changes its message capability', () => {
  const targets = [
    { id: 'box', kind: 'imp', options: {}, identity: 'imp:a', provider: null },
  ] as const;

  const quiet = buildAgentList(
    [buildMockAgentAdapter({ id: 'zai', takesMessages: false })],
    () => true,
    [],
  );

  const talking = buildAgentList(
    [buildMockAgentAdapter({ id: 'zai', takesMessages: true })],
    () => true,
    [],
  );

  expect(
    buildConfigRevision(targets, 'box', [], { entries: quiet, defaultAgent: 'claude' }),
  ).not.toBe(buildConfigRevision(targets, 'box', [], { entries: talking, defaultAgent: 'claude' }));
});

test('it builds another revision when the default agent changes', () => {
  const targets = [
    { id: 'box', kind: 'imp', options: {}, identity: 'imp:a', provider: null },
  ] as const;

  expect(buildConfigRevision(targets, 'box', [], { entries: [], defaultAgent: 'claude' })).not.toBe(
    buildConfigRevision(targets, 'box', [], { entries: [], defaultAgent: 'zai' }),
  );
});
