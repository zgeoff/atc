import { expect, onTestFinished, test } from 'bun:test';
import { TargetUnavailableError } from '@atc/plugin-api';
import { buildMockExecutionHostServices } from '@atc/plugin-api/test-utils/build-mock-execution-host-services';
import { IMP_PLUGIN } from './imp-plugin';

test('it creates an imp provider for a target with a url and a set token variable', () => {
  const provider = IMP_PLUGIN.create(
    {
      id: 'box',
      options: { url: 'http://127.0.0.1:9', tokenEnv: 'ATC_TEST_IMP_TOKEN' },
      env: { ATC_TEST_IMP_TOKEN: 'token-value' },
    },
    buildMockExecutionHostServices({ version: '1.0.0' }),
    { authProfiles: new Map() },
  );

  expect(provider.kind).toBe('imp');
});

test.each([
  ['https://imp.example.dev/', 'https://imp.example.dev'],
  ['https://IMP.example.dev', 'https://imp.example.dev'],
])('it places the imp target with url %s in the shared place of %s', (url, normalized) => {
  expect(IMP_PLUGIN.place?.({ url, tokenEnv: 'A', image: 'dev' })).toStrictEqual({
    scope: 'shared',
    version: 'place-v1',
    parts: { url: normalized },
  });
});

test('it places an imp target with no url in a daemon place', () => {
  expect(IMP_PLUGIN.place?.({ tokenEnv: 'A' })).toStrictEqual({ scope: 'daemon' });
});

test('it creates a provider that clones on its host, takes the daemon git identity, and can trust a clone', () => {
  const provider = IMP_PLUGIN.create(
    {
      id: 'box',
      options: { url: 'http://127.0.0.1:9', tokenEnv: 'ATC_TEST_IMP_TOKEN' },
      env: { ATC_TEST_IMP_TOKEN: 'token-value' },
    },
    buildMockExecutionHostServices({ version: '1.0.0' }),
    { authProfiles: new Map() },
  );

  onTestFinished(async () => {
    await provider.dispose();
  });

  expect(provider).toContainEntries([
    ['cloneOnTarget', true],
    ['hostGitIdentity', true],
    ['guestWorkspaceTrust', true],
  ]);
});

test('it declares the identity version and the options that never select an existing imp', () => {
  expect(IMP_PLUGIN.identity).toStrictEqual({
    version: 'reach-v1',
    ignoredOptions: [
      'image',
      'memoryMib',
      'maxMemoryMib',
      'guestATC',
      'rebindChangedAuth',
      'sessionEnv',
    ],
  });
});

test('it refuses a target whose token variable is unset with the problem it holds', () => {
  expect(() =>
    IMP_PLUGIN.create(
      {
        id: 'box',
        options: { url: 'http://127.0.0.1:9', tokenEnv: 'ATC_TEST_IMP_TOKEN' },
        env: {},
      },
      buildMockExecutionHostServices({ version: '1.0.0' }),
      { authProfiles: new Map() },
    ),
  ).toThrowWithMessage(
    TargetUnavailableError,
    'target "box" reads its impd token from ATC_TEST_IMP_TOKEN, which is unset or empty in the daemon\'s environment',
  );
});

test('it refuses a target without a url as one with no provider configured', () => {
  expect(() =>
    IMP_PLUGIN.create({ id: 'box', options: {}, env: {} }, buildMockExecutionHostServices(), {
      authProfiles: new Map(),
    }),
  ).toThrowWithMessage(TargetUnavailableError, 'target "box" has no provider configured');
});
