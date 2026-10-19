import { expect, test } from 'bun:test';
import { buildConfigRevision } from './build-config-revision';
import { buildExecutionTargets } from './build-execution-targets';

test('it builds the revision a daemon reported before the providers moved into packages', () => {
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

  // clients compare this revision across daemons and restarts, so no change
  // to where a provider's code lives may move it while the config stays
  // the same
  expect(buildConfigRevision(built.targets, 'local', built.errors)).toBe('de9f7e4d5dd5c55e');
});

test('it builds a sixteen-digit hex revision', () => {
  expect(
    buildConfigRevision(
      [{ id: 'local', kind: 'local-pty', options: {}, identity: 'local-pty:a', provider: null }],
      'local',
      [],
    ),
  ).toMatch(/^[\da-f]{16}$/u);
});

test('it builds the same revision for the same targets, default, and errors', () => {
  expect(
    buildConfigRevision(
      [{ id: 'box', kind: 'imp', options: {}, identity: 'imp:a', provider: null }],
      'box',
      [{ scope: 'target', target: 'other', problem: 'bad' }],
    ),
  ).toBe(
    buildConfigRevision(
      [{ id: 'box', kind: 'imp', options: {}, identity: 'imp:a', provider: null }],
      'box',
      [{ scope: 'target', target: 'other', problem: 'bad' }],
    ),
  );
});

test('it builds another revision when a target identity changes', () => {
  expect(
    buildConfigRevision(
      [{ id: 'box', kind: 'imp', options: {}, identity: 'imp:a', provider: null }],
      'box',
      [],
    ),
  ).not.toBe(
    buildConfigRevision(
      [{ id: 'box', kind: 'imp', options: {}, identity: 'imp:b', provider: null }],
      'box',
      [],
    ),
  );
});

test('it builds another revision when the default target changes', () => {
  expect(
    buildConfigRevision(
      [{ id: 'box', kind: 'imp', options: {}, identity: 'imp:a', provider: null }],
      'box',
      [],
    ),
  ).not.toBe(
    buildConfigRevision(
      [{ id: 'box', kind: 'imp', options: {}, identity: 'imp:a', provider: null }],
      null,
      [],
    ),
  );
});

test('it builds another revision when the config errors change', () => {
  expect(
    buildConfigRevision(
      [{ id: 'box', kind: 'imp', options: {}, identity: 'imp:a', provider: null }],
      'box',
      [],
    ),
  ).not.toBe(
    buildConfigRevision(
      [{ id: 'box', kind: 'imp', options: {}, identity: 'imp:a', provider: null }],
      'box',
      [{ scope: 'target', target: 'other', problem: 'bad' }],
    ),
  );
});
