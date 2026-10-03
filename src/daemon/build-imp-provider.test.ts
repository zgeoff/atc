import { expect, test } from 'bun:test';
import { buildImpProvider } from './build-imp-provider';
import { ImpProvider } from './imp-provider';

test('it builds no provider for an imp target without a url', () => {
  expect(buildImpProvider('box', { tokenEnv: 'ATC_TEST_IMP_TOKEN' }, {})).toStrictEqual({
    provider: null,
    problem: null,
  });
});

test("it builds an imp provider that takes the target's guest options without calling impd", () => {
  const built = buildImpProvider(
    'box',
    {
      url: 'http://127.0.0.1:9',
      tokenEnv: 'ATC_TEST_IMP_TOKEN',
      guestDir: '/srv/atc',
      guestATC: '/usr/local/bin/atc',
    },
    { ATC_TEST_IMP_TOKEN: 'token-value' },
  );

  if (built.provider === null) {
    throw new Error('expected an imp provider');
  }

  expect(built.problem).toBeNull();
  expect(built.provider).toBeInstanceOf(ImpProvider);
  expect(built.provider.guest).toStrictEqual({ dir: '/srv/atc', atc: '/usr/local/bin/atc' });
});

test('it builds an imp provider with no token for a target that sets no tokenEnv', () => {
  const built = buildImpProvider('box', { url: 'http://127.0.0.1:9' }, {});

  expect(built.problem).toBeNull();
  expect(built.provider).toBeInstanceOf(ImpProvider);
});

test('it reports a target whose tokenEnv variable is unset, without a provider', () => {
  const built = buildImpProvider(
    'box',
    { url: 'http://127.0.0.1:9', tokenEnv: 'ATC_TEST_IMP_TOKEN' },
    { OTHER: 'other-value' },
  );

  expect(built).toStrictEqual({
    provider: null,
    problem:
      'target "box" reads its impd token from ATC_TEST_IMP_TOKEN, which is unset or empty in the daemon\'s environment',
  });
});

test('it reports a target whose tokenEnv variable is empty, without a provider', () => {
  const built = buildImpProvider(
    'box',
    { url: 'http://127.0.0.1:9', tokenEnv: 'ATC_TEST_IMP_TOKEN' },
    { ATC_TEST_IMP_TOKEN: '' },
  );

  expect(built).toStrictEqual({
    provider: null,
    problem:
      'target "box" reads its impd token from ATC_TEST_IMP_TOKEN, which is unset or empty in the daemon\'s environment',
  });
});

test('it reports a target whose tokenEnv is not a non-empty string, without a provider', () => {
  const built = buildImpProvider('box', { url: 'http://127.0.0.1:9', tokenEnv: 7 }, {});

  expect(built).toStrictEqual({
    provider: null,
    problem: 'target "box" must give tokenEnv as a non-empty string',
  });
});
