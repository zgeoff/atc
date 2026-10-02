import { expect, test } from 'bun:test';
import { collectTargets } from './collect-targets';

test('it holds one implicit local target when the config sets no targets', () => {
  expect(collectTargets(undefined, undefined)).toStrictEqual({
    targets: [{ id: 'local', provider: 'local-pty', options: {} }],
    defaultTarget: 'local',
    warnings: [],
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
    warnings: [],
  });
});

test('it turns local sessions off for a well-formed targets map without local', () => {
  expect(collectTargets({ box: { provider: 'imp' } }, undefined)).toStrictEqual({
    targets: [{ id: 'box', provider: 'imp', options: {} }],
    defaultTarget: 'box',
    warnings: [],
  });
});

test.each([
  ['a string', 'local'],
  ['an array', [{ provider: 'local-pty' }]],
  ['null', null],
])('it falls back to local alone with a warning when targets is %s', (_label, raw) => {
  expect(collectTargets(raw, undefined)).toStrictEqual({
    targets: [{ id: 'local', provider: 'local-pty', options: {} }],
    defaultTarget: 'local',
    warnings: ["targets must be a non-empty object of named targets; using only 'local'"],
  });
});

test('it falls back to local alone with a warning when targets is empty', () => {
  expect(collectTargets({}, undefined)).toStrictEqual({
    targets: [{ id: 'local', provider: 'local-pty', options: {} }],
    defaultTarget: 'local',
    warnings: ["targets must be a non-empty object of named targets; using only 'local'"],
  });
});

test.each([
  ['an entry that is not an object', { box: 'imp' }],
  ['an entry without a provider', { box: { image: 'dev' } }],
  ['an entry whose provider is not a string', { box: { provider: 7 } }],
  ['an entry whose provider is empty', { box: { provider: '' } }],
])('it falls back to local alone with a warning for %s', (_label, raw) => {
  expect(collectTargets(raw, undefined)).toStrictEqual({
    targets: [{ id: 'local', provider: 'local-pty', options: {} }],
    defaultTarget: 'local',
    warnings: [
      'target "box" must be an object with a non-empty string provider; using only \'local\'',
    ],
  });
});

test('it drops every target of a map with one malformed entry, even a well-formed one', () => {
  expect(
    collectTargets({ box: { provider: 'imp' }, broken: { provider: 3 } }, 'box'),
  ).toStrictEqual({
    targets: [{ id: 'local', provider: 'local-pty', options: {} }],
    defaultTarget: 'local',
    warnings: [
      'target "broken" must be an object with a non-empty string provider; using only \'local\'',
      'defaultTarget "box" matches no configured target; using \'local\'',
    ],
  });
});

test('it falls back to local with a warning for a default that matches no target', () => {
  expect(
    collectTargets({ local: { provider: 'local-pty' }, box: { provider: 'imp' } }, 'gone'),
  ).toStrictEqual({
    targets: [
      { id: 'local', provider: 'local-pty', options: {} },
      { id: 'box', provider: 'imp', options: {} },
    ],
    defaultTarget: 'local',
    warnings: ['defaultTarget "gone" matches no configured target; using \'local\''],
  });
});

test('it falls back to the first target with a warning for an unmatched default when local is off', () => {
  expect(
    collectTargets({ box: { provider: 'imp' }, other: { provider: 'imp' } }, 'gone'),
  ).toStrictEqual({
    targets: [
      { id: 'box', provider: 'imp', options: {} },
      { id: 'other', provider: 'imp', options: {} },
    ],
    defaultTarget: 'box',
    warnings: ['defaultTarget "gone" matches no configured target; using \'box\''],
  });
});

test('it falls back with a warning for a default that is not a string', () => {
  expect(collectTargets(undefined, 4)).toStrictEqual({
    targets: [{ id: 'local', provider: 'local-pty', options: {} }],
    defaultTarget: 'local',
    warnings: ["defaultTarget 4 matches no configured target; using 'local'"],
  });
});
