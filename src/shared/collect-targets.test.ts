import { expect, test } from 'bun:test';
import { collectTargets } from './collect-targets';

test('it holds one implicit local target as the default when the config sets no targets', () => {
  expect(collectTargets(undefined, undefined)).toStrictEqual({
    targets: [{ id: 'local', provider: 'local-pty', options: {} }],
    defaultTarget: 'local',
    errors: [],
  });
});

test('it reads each named target with its provider and the rest of its keys as options', () => {
  expect(
    collectTargets(
      {
        local: { provider: 'local-pty' },
        box: { provider: 'imp', image: 'dev', region: 'syd' },
      },
      'box',
    ),
  ).toStrictEqual({
    targets: [
      { id: 'local', provider: 'local-pty', options: {} },
      { id: 'box', provider: 'imp', options: { image: 'dev', region: 'syd' } },
    ],
    defaultTarget: 'box',
    errors: [],
  });
});

test('it defaults to the local entry of a targets map without a defaultTarget', () => {
  expect(
    collectTargets({ box: { provider: 'imp' }, local: { provider: 'local-pty' } }, undefined),
  ).toMatchObject({ defaultTarget: 'local', errors: [] });
});

test('it leaves no default for a targets map without local or a defaultTarget', () => {
  expect(collectTargets({ box: { provider: 'imp' } }, undefined)).toStrictEqual({
    targets: [{ id: 'box', provider: 'imp', options: {} }],
    defaultTarget: null,
    errors: [],
  });
});

test.each([
  ['a string', 'local'],
  ['an array', [{ provider: 'local-pty' }]],
  ['null', null],
  ['empty', {}],
])('it holds no targets and an error when targets is %s', (_label, raw) => {
  expect(collectTargets(raw, undefined)).toStrictEqual({
    targets: [],
    defaultTarget: null,
    errors: [{ scope: 'targets', problem: 'targets must be a non-empty object of named targets' }],
  });
});

test.each([
  ['an entry that is not an object', 'imp'],
  ['an entry without a provider', { image: 'dev' }],
  ['an entry whose provider is not a string', { provider: 7 }],
  ['an entry whose provider is empty', { provider: '' }],
])('it leaves out %s with an error and keeps the other entries', (_label, entry) => {
  expect(collectTargets({ local: { provider: 'local-pty' }, box: entry }, undefined)).toStrictEqual(
    {
      targets: [{ id: 'local', provider: 'local-pty', options: {} }],
      defaultTarget: 'local',
      errors: [
        {
          scope: 'target',
          target: 'box',
          problem: 'target "box" must be an object with a non-empty string provider',
        },
      ],
    },
  );
});

test('it leaves no default when a malformed local entry is the one the default would be', () => {
  expect(collectTargets({ local: 'local-pty', box: { provider: 'imp' } }, undefined)).toStrictEqual(
    {
      targets: [{ id: 'box', provider: 'imp', options: {} }],
      defaultTarget: null,
      errors: [
        {
          scope: 'target',
          target: 'local',
          problem: 'target "local" must be an object with a non-empty string provider',
        },
      ],
    },
  );
});

test.each([
  ['a target the map does not hold', 'gone'],
  ['a malformed entry', 'broken'],
  ['not a string', 4],
])('it leaves no default and an error for a defaultTarget that is %s', (_label, rawDefault) => {
  expect(
    collectTargets({ local: { provider: 'local-pty' }, broken: { provider: 3 } }, rawDefault),
  ).toMatchObject({
    defaultTarget: null,
    errors: [
      { scope: 'target', target: 'broken' },
      {
        scope: 'defaultTarget',
        problem: `defaultTarget ${JSON.stringify(rawDefault)} matches no well-formed target in targets`,
      },
    ],
  });
});

test('it reads a defaultTarget without a targets map against the implicit local target', () => {
  expect(collectTargets(undefined, 'local')).toStrictEqual({
    targets: [{ id: 'local', provider: 'local-pty', options: {} }],
    defaultTarget: 'local',
    errors: [],
  });
});

test('it leaves no default for a defaultTarget other than local without a targets map', () => {
  expect(collectTargets(undefined, 'box')).toStrictEqual({
    targets: [{ id: 'local', provider: 'local-pty', options: {} }],
    defaultTarget: null,
    errors: [
      {
        scope: 'defaultTarget',
        problem: 'defaultTarget "box" matches no well-formed target in targets',
      },
    ],
  });
});
