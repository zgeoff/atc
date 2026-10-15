import { expect, test } from 'bun:test';
import { TargetUnavailableError } from '@atc/plugin-api';
import { buildMockHostServices } from '@atc/test-utils';
import { IMP_PLUGIN } from './imp-plugin';
import { ImpProvider } from './imp-provider';

test('it creates an imp provider for a target with a url and a set token variable', () => {
  const provider = IMP_PLUGIN.create(
    {
      id: 'box',
      options: { url: 'http://127.0.0.1:9', tokenEnv: 'ATC_TEST_IMP_TOKEN' },
      env: { ATC_TEST_IMP_TOKEN: 'token-value' },
    },
    buildMockHostServices({ version: '1.0.0' }),
    { authProfiles: new Map() },
  );

  expect(provider).toBeInstanceOf(ImpProvider);
});

test('it refuses a target whose token variable is unset with the problem it holds', () => {
  expect(() =>
    IMP_PLUGIN.create(
      {
        id: 'box',
        options: { url: 'http://127.0.0.1:9', tokenEnv: 'ATC_TEST_IMP_TOKEN' },
        env: {},
      },
      buildMockHostServices({ version: '1.0.0' }),
      { authProfiles: new Map() },
    ),
  ).toThrowWithMessage(
    TargetUnavailableError,
    'target "box" reads its impd token from ATC_TEST_IMP_TOKEN, which is unset or empty in the daemon\'s environment',
  );
});

test('it refuses a target without a url as one with no provider configured', () => {
  expect(() =>
    IMP_PLUGIN.create({ id: 'box', options: {}, env: {} }, buildMockHostServices(), {
      authProfiles: new Map(),
    }),
  ).toThrowWithMessage(TargetUnavailableError, 'target "box" has no provider configured');
});
