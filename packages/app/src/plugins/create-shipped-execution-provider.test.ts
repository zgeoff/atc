import { expect, onTestFinished, test } from 'bun:test';
import { buildExecutionTargets } from '@atc/daemon';
import { buildMockAuthProfile, buildMockHostServices } from '@atc/test-utils';
import { createShippedExecutionProvider } from './create-shipped-execution-provider';

test('it builds the shipped provider a target entry selects', () => {
  const built = createShippedExecutionProvider(
    {
      id: 'cloud',
      provider: 'imp',
      options: { url: 'http://impd.example:7070', tokenEnv: 'FIXTURE_IMP_TOKEN' },
    },
    buildMockHostServices({ version: '1.0.0' }),
    { FIXTURE_IMP_TOKEN: 'fixture-token' },
    new Map(),
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
      createShippedExecutionProvider(
        config,
        buildMockHostServices({ version: '1.0.0' }),
        { EXAMPLE_TOKEN: 'fixture-token' },
        new Map(),
      ),
  );

  onTestFinished(async () => {
    await built.targets[0]?.provider?.dispose();
  });

  expect(built.targets[0]?.provider?.kind).toBe('imp');
  expect(built.targets[0]?.identity).toBe('imp:reach-v1:6b55bacee6685673');
});

test('it builds no provider and the problem for an imp entry whose token variable is unset', () => {
  const built = createShippedExecutionProvider(
    {
      id: 'box',
      provider: 'imp',
      options: { url: 'http://127.0.0.1:9', tokenEnv: 'ATC_TEST_IMP_TOKEN' },
    },
    buildMockHostServices({ version: '1.0.0' }),
    {},
    new Map(),
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
  const built = createShippedExecutionProvider(
    { id: 'far', provider: 'teleport', options: {} },
    buildMockHostServices({ version: '1.0.0' }),
    {},
    new Map(),
  );

  expect(built).toStrictEqual({ provider: null, problem: null });
});

test('it shows an error on each imp target when a profile has a secret name impd refuses', () => {
  const profile = buildMockAuthProfile({ name: 'notes', secret: 'Notes_Key' });

  const built = buildExecutionTargets(
    [
      { id: 'cloud', provider: 'imp', options: { url: 'http://impd.example:7070' } },
      { id: 'lab', provider: 'imp', options: { url: 'http://impd.example:7071' } },
      { id: 'local', provider: 'local-pty', options: {} },
    ],
    (config) =>
      createShippedExecutionProvider(
        config,
        buildMockHostServices({ version: '1.0.0' }),
        {},
        new Map([['notes', profile]]),
      ),
  );

  onTestFinished(async () => {
    await built.targets[2]?.provider?.dispose();
  });

  expect(built.errors).toStrictEqual([
    {
      scope: 'target',
      target: 'cloud',
      problem:
        'target "cloud" cannot use authProfiles.notes: its secret must be a lowercase letter followed by up to 30 lowercase letters, digits or hyphens, the secret names impd accepts',
    },
    {
      scope: 'target',
      target: 'lab',
      problem:
        'target "lab" cannot use authProfiles.notes: its secret must be a lowercase letter followed by up to 30 lowercase letters, digits or hyphens, the secret names impd accepts',
    },
  ]);
});

test('it shows no error for a profile with a secret name impd refuses when no imp target is configured', () => {
  const profile = buildMockAuthProfile({ name: 'notes', secret: 'Notes_Key' });

  const built = buildExecutionTargets(
    [{ id: 'local', provider: 'local-pty', options: {} }],
    (config) =>
      createShippedExecutionProvider(
        config,
        buildMockHostServices({ version: '1.0.0' }),
        {},
        new Map([['notes', profile]]),
      ),
  );

  onTestFinished(async () => {
    await built.targets[0]?.provider?.dispose();
  });

  expect(built.errors).toStrictEqual([]);
  expect(built.targets[0]?.provider?.kind).toBe('local-pty');
});
