import { expect, test } from 'bun:test';
import { buildTargetIdentity } from '../daemon/build-target-identity';
import { buildStubExecutionProvider } from './build-stub-execution-provider';
import { buildTargetOptionsFromConfig } from './build-target-options-from-config';

test('it gives each parsed target the provider its kind builds for its id', () => {
  const local = buildStubExecutionProvider({ kind: 'local-pty' });
  const box = buildStubExecutionProvider({ kind: 'local-pty' });

  const options = buildTargetOptionsFromConfig(
    { targets: { local: { provider: 'local-pty' }, box: { provider: 'local-pty' } } },
    new Map([['local-pty', (id: string) => (id === 'local' ? local : box)]]),
  );

  expect(options).toStrictEqual({
    targets: [
      {
        id: 'local',
        kind: 'local-pty',
        options: {},
        identity: buildTargetIdentity('local-pty', {}),
        provider: local,
      },
      {
        id: 'box',
        kind: 'local-pty',
        options: {},
        identity: buildTargetIdentity('local-pty', {}),
        provider: box,
      },
    ],
    defaultTarget: 'local',
    targetErrors: [],
  });
});

test('it leaves a target whose kind no factory serves without a provider', () => {
  const options = buildTargetOptionsFromConfig(
    {
      targets: { local: { provider: 'local-pty' }, box: { provider: 'imp' } },
      defaultTarget: 'box',
    },
    new Map(),
  );

  expect(options).toStrictEqual({
    targets: [
      {
        id: 'local',
        kind: 'local-pty',
        options: {},
        identity: buildTargetIdentity('local-pty', {}),
        provider: null,
      },
      {
        id: 'box',
        kind: 'imp',
        options: {},
        identity: buildTargetIdentity('imp', {}),
        provider: null,
      },
    ],
    defaultTarget: 'box',
    targetErrors: [],
  });
});

test('it passes each parse error through as a target config error', () => {
  const options = buildTargetOptionsFromConfig(
    { targets: { local: { provider: 'local-pty' }, box: { image: 'dev' } } },
    new Map(),
  );

  expect(options.targetErrors).toStrictEqual([
    {
      scope: 'target',
      target: 'box',
      problem: 'target "box" must be an object with a non-empty string provider',
    },
  ]);
});
