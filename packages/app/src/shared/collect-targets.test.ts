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
  ).toStrictEqual({
    targets: [
      { id: 'box', provider: 'imp', options: {} },
      { id: 'local', provider: 'local-pty', options: {} },
    ],
    defaultTarget: 'local',
    errors: [],
  });
});

test('it leaves no default for a targets map without local or a defaultTarget', () => {
  expect(collectTargets({ box: { provider: 'imp' } }, undefined)).toStrictEqual({
    targets: [{ id: 'box', provider: 'imp', options: {} }],
    defaultTarget: null,
    errors: [],
  });
});

test('it holds no targets and an error when targets is a string', () => {
  expect(collectTargets('local', undefined)).toStrictEqual({
    targets: [],
    defaultTarget: null,
    errors: [{ scope: 'targets', problem: 'targets must be a non-empty object of named targets' }],
  });
});

test('it holds no targets and an error when targets is an array', () => {
  expect(collectTargets([{ provider: 'local-pty' }], undefined)).toStrictEqual({
    targets: [],
    defaultTarget: null,
    errors: [{ scope: 'targets', problem: 'targets must be a non-empty object of named targets' }],
  });
});

test('it holds no targets and an error when targets is null', () => {
  expect(collectTargets(null, undefined)).toStrictEqual({
    targets: [],
    defaultTarget: null,
    errors: [{ scope: 'targets', problem: 'targets must be a non-empty object of named targets' }],
  });
});

test('it holds no targets and an error when targets is empty', () => {
  expect(collectTargets({}, undefined)).toStrictEqual({
    targets: [],
    defaultTarget: null,
    errors: [{ scope: 'targets', problem: 'targets must be a non-empty object of named targets' }],
  });
});

test('it leaves out an entry that is not an object with an error and keeps the other entries', () => {
  expect(collectTargets({ local: { provider: 'local-pty' }, box: 'imp' }, undefined)).toStrictEqual(
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

test('it leaves out an entry without a provider with an error and keeps the other entries', () => {
  expect(
    collectTargets({ local: { provider: 'local-pty' }, box: { image: 'dev' } }, undefined),
  ).toStrictEqual({
    targets: [{ id: 'local', provider: 'local-pty', options: {} }],
    defaultTarget: 'local',
    errors: [
      {
        scope: 'target',
        target: 'box',
        problem: 'target "box" must be an object with a non-empty string provider',
      },
    ],
  });
});

test('it leaves out an entry whose provider is not a string with an error and keeps the other entries', () => {
  expect(
    collectTargets({ local: { provider: 'local-pty' }, box: { provider: 7 } }, undefined),
  ).toStrictEqual({
    targets: [{ id: 'local', provider: 'local-pty', options: {} }],
    defaultTarget: 'local',
    errors: [
      {
        scope: 'target',
        target: 'box',
        problem: 'target "box" must be an object with a non-empty string provider',
      },
    ],
  });
});

test('it leaves out an entry whose provider is empty with an error and keeps the other entries', () => {
  expect(
    collectTargets({ local: { provider: 'local-pty' }, box: { provider: '' } }, undefined),
  ).toStrictEqual({
    targets: [{ id: 'local', provider: 'local-pty', options: {} }],
    defaultTarget: 'local',
    errors: [
      {
        scope: 'target',
        target: 'box',
        problem: 'target "box" must be an object with a non-empty string provider',
      },
    ],
  });
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

test('it leaves no default and an error for a defaultTarget that is a target the map does not hold', () => {
  expect(collectTargets({ local: { provider: 'local-pty' } }, 'gone')).toStrictEqual({
    targets: [{ id: 'local', provider: 'local-pty', options: {} }],
    defaultTarget: null,
    errors: [
      {
        scope: 'defaultTarget',
        problem: 'defaultTarget: matches no well-formed target in targets',
      },
    ],
  });
});

test('it leaves no default and an error for a defaultTarget that is a malformed entry', () => {
  expect(
    collectTargets({ local: { provider: 'local-pty' }, broken: { provider: 3 } }, 'broken'),
  ).toStrictEqual({
    targets: [{ id: 'local', provider: 'local-pty', options: {} }],
    defaultTarget: null,
    errors: [
      {
        scope: 'target',
        target: 'broken',
        problem: 'target "broken" must be an object with a non-empty string provider',
      },
      {
        scope: 'defaultTarget',
        problem: 'defaultTarget: matches no well-formed target in targets',
      },
    ],
  });
});

test('it leaves no default and an error for a defaultTarget that is a number', () => {
  expect(collectTargets({ local: { provider: 'local-pty' } }, 4)).toStrictEqual({
    targets: [{ id: 'local', provider: 'local-pty', options: {} }],
    defaultTarget: null,
    errors: [{ scope: 'defaultTarget', problem: 'defaultTarget: expected a string, got a number' }],
  });
});

test('it leaves no default and an error for a defaultTarget that is an object', () => {
  expect(collectTargets({ local: { provider: 'local-pty' } }, { token: 'x' })).toStrictEqual({
    targets: [{ id: 'local', provider: 'local-pty', options: {} }],
    defaultTarget: null,
    errors: [
      { scope: 'defaultTarget', problem: 'defaultTarget: expected a string, got an object' },
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
        problem: 'defaultTarget: matches no well-formed target in targets',
      },
    ],
  });
});

test.each([true, false])(
  'it preserves the explicit target clone trust default %s',
  (trustClonedWorkspace) => {
    expect(collectTargets({ box: { provider: 'imp', trustClonedWorkspace } }, 'box')).toStrictEqual(
      {
        targets: [{ id: 'box', provider: 'imp', options: { trustClonedWorkspace } }],
        defaultTarget: 'box',
        errors: [],
      },
    );
  },
);

test.each(['true', 1, null, {}])(
  'it rejects non-boolean target clone trust %s',
  (trustClonedWorkspace) => {
    expect(
      collectTargets(
        { local: { provider: 'local-pty' }, box: { provider: 'imp', trustClonedWorkspace } },
        undefined,
      ),
    ).toStrictEqual({
      targets: [{ id: 'local', provider: 'local-pty', options: {} }],
      defaultTarget: 'local',
      errors: [
        {
          scope: 'target',
          target: 'box',
          problem: 'target "box" must give trustClonedWorkspace as a boolean',
        },
      ],
    });
  },
);
