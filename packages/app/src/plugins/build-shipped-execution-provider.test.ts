import { expect, onTestFinished, test } from 'bun:test';
import { buildExecutionTargets } from '@atc/daemon';
import { buildMockHostServices } from '@atc/test-utils';
import { buildShippedExecutionProvider } from './build-shipped-execution-provider';

test('it builds the shipped provider a target entry selects', () => {
  const built = buildShippedExecutionProvider(
    {
      id: 'cloud',
      provider: 'imp',
      options: { url: 'http://impd.example:7070', tokenEnv: 'FIXTURE_IMP_TOKEN' },
    },
    buildMockHostServices({ version: '1.0.0' }),
    { FIXTURE_IMP_TOKEN: 'fixture-token' },
  );

  onTestFinished(async () => {
    await built.provider?.dispose();
  });

  expect(built.provider?.kind).toBe('imp');
  expect(built.problem).toBeNull();
});

// stored sessions hold this exact string for the config, so a provider that
// builds must still give its target the plugin's versioned identity
test('it gives a target whose imp provider builds the identity its stored sessions hold', () => {
  const built = buildExecutionTargets(
    [
      {
        id: 'cloud',
        provider: 'imp',
        options: {
          url: 'http://impd.example:7070',
          tokenEnv: 'EXAMPLE_TOKEN',
          image: 'dev',
          memoryMib: 4096,
          guestATC: 'bundled',
          rebindChangedAuth: true,
          dropSysAdmin: true,
          trustClonedWorkspace: true,
        },
      },
    ],
    (config) =>
      buildShippedExecutionProvider(config, buildMockHostServices({ version: '1.0.0' }), {
        EXAMPLE_TOKEN: 'fixture-token',
      }),
  );

  onTestFinished(async () => {
    await built.targets[0]?.provider?.dispose();
  });

  expect(built.targets[0]?.provider?.kind).toBe('imp');
  expect(built.targets[0]?.identity).toBe('imp:reach-v1:6b55bacee6685673');
});

test('it builds no provider and the problem for an imp entry whose token variable is unset', () => {
  const built = buildShippedExecutionProvider(
    {
      id: 'box',
      provider: 'imp',
      options: { url: 'http://127.0.0.1:9', tokenEnv: 'ATC_TEST_IMP_TOKEN' },
    },
    buildMockHostServices({ version: '1.0.0' }),
    {},
  );

  expect(built).toStrictEqual({
    provider: null,
    problem:
      'target "box" reads its impd token from ATC_TEST_IMP_TOKEN, which is unset or empty in the daemon\'s environment',
    identityRule: {
      version: 'reach-v1',
      ignoredOptions: ['image', 'memoryMib', 'guestATC', 'rebindChangedAuth'],
    },
  });
});

test('it builds no provider and no problem for a kind this build ships no plugin for', () => {
  const built = buildShippedExecutionProvider(
    { id: 'far', provider: 'teleport', options: {} },
    buildMockHostServices({ version: '1.0.0' }),
    {},
  );

  expect(built).toStrictEqual({ provider: null, problem: null });
});
