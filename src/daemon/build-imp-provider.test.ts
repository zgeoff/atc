import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '../../test/setup-temp-dir';
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

test('it builds an imp provider for a target whose token file holds a token', () => {
  using tmp = setupTempDir('atc-build-imp-provider-');

  const tokenPath = join(tmp.dir, 'imp-token');

  writeFileSync(tokenPath, 'file-token\n');

  const built = buildImpProvider('box', { url: 'http://127.0.0.1:9', tokenFile: tokenPath }, {});

  expect(built.problem).toBeNull();
  expect(built.provider).toBeInstanceOf(ImpProvider);
});

test('it reports a target that gives both tokenEnv and tokenFile, without a provider', () => {
  using tmp = setupTempDir('atc-build-imp-provider-');

  const tokenPath = join(tmp.dir, 'imp-token');

  writeFileSync(tokenPath, 'file-token\n');

  const built = buildImpProvider(
    'box',
    { url: 'http://127.0.0.1:9', tokenEnv: 'ATC_TEST_IMP_TOKEN', tokenFile: tokenPath },
    { ATC_TEST_IMP_TOKEN: 'token-value' },
  );

  expect(built).toStrictEqual({
    provider: null,
    problem: 'target "box" must give its impd token through tokenEnv or tokenFile, not both',
  });
});

test('it reports a target whose token file is empty, without a provider', () => {
  using tmp = setupTempDir('atc-build-imp-provider-');

  const tokenPath = join(tmp.dir, 'imp-token');

  writeFileSync(tokenPath, '\n');

  const built = buildImpProvider('box', { url: 'http://127.0.0.1:9', tokenFile: tokenPath }, {});

  expect(built).toStrictEqual({
    provider: null,
    problem: `target "box" reads its impd token from a file it cannot use: the impd token file ${tokenPath} is empty`,
  });
});

test('it reports a target whose token file is missing, without a provider', () => {
  using tmp = setupTempDir('atc-build-imp-provider-');

  const tokenPath = join(tmp.dir, 'imp-token');
  const built = buildImpProvider('box', { url: 'http://127.0.0.1:9', tokenFile: tokenPath }, {});

  expect(built).toStrictEqual({
    provider: null,
    problem: `target "box" reads its impd token from a file it cannot use: cannot read the impd token file ${tokenPath}: ENOENT`,
  });
});

test('it reports a target whose tokenFile is not a non-empty string, without a provider', () => {
  const built = buildImpProvider('box', { url: 'http://127.0.0.1:9', tokenFile: '' }, {});

  expect(built).toStrictEqual({
    provider: null,
    problem: 'target "box" must give tokenFile as a non-empty string',
  });
});
