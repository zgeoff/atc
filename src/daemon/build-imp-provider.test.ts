import { expect, test } from 'bun:test';
import { buildImpProvider } from './build-imp-provider';
import { ImpProvider } from './imp-provider';

test('it builds no provider for an imp target without a url', () => {
  expect(buildImpProvider({ tokenEnv: 'ATC_TEST_IMP_TOKEN' })).toBeNull();
});

test("it builds an imp provider that takes the target's guest options without calling impd", () => {
  const provider = buildImpProvider({
    url: 'http://127.0.0.1:9',
    tokenEnv: 'ATC_TEST_IMP_TOKEN',
    guestDir: '/srv/atc',
    guestATC: '/usr/local/bin/atc',
  });

  expect(provider).toBeInstanceOf(ImpProvider);
  expect(provider?.guest).toStrictEqual({ dir: '/srv/atc', atc: '/usr/local/bin/atc' });
});
