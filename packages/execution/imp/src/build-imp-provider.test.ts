import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '@atc/test-utils/setup-temp-dir';
import invariant from 'tiny-invariant';
import { buildImpProvider } from './build-imp-provider';
import { ImpProvider } from './imp-provider';

function setupTest() {
  const tmp = setupTempDir('atc-build-imp-provider-');

  return { dir: tmp.dir };
}

test('it builds no provider for an imp target without a url', () => {
  expect(buildImpProvider('box', { tokenEnv: 'ATC_TEST_IMP_TOKEN' }, '1.0.0', {})).toStrictEqual({
    provider: null,
    problem: null,
  });
});

test("it builds an imp provider that takes the target's guest options", () => {
  const built = buildImpProvider(
    'box',
    {
      url: 'http://127.0.0.1:9',
      tokenEnv: 'ATC_TEST_IMP_TOKEN',
      guestDir: '/srv/atc',
      guestATC: '/usr/local/bin/atc',
    },
    '1.0.0',
    { ATC_TEST_IMP_TOKEN: 'token-value' },
  );

  invariant(built.provider !== null, 'expected an imp provider');

  expect(built.problem).toBeNull();
  expect(built.provider).toBeInstanceOf(ImpProvider);
  expect(built.provider.guest).toStrictEqual({ dir: '/srv/atc', atc: '/srv/atc/bin/atc' });
});

test('it builds an imp provider with no token for a target that sets no tokenEnv', () => {
  const built = buildImpProvider('box', { url: 'http://127.0.0.1:9' }, '1.0.0', {});

  expect(built.problem).toBeNull();
  expect(built.provider).toBeInstanceOf(ImpProvider);
});

test('it reports a target whose tokenEnv variable is unset, without a provider', () => {
  const built = buildImpProvider(
    'box',
    { url: 'http://127.0.0.1:9', tokenEnv: 'ATC_TEST_IMP_TOKEN' },
    '1.0.0',
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
    '1.0.0',
    { ATC_TEST_IMP_TOKEN: '' },
  );

  expect(built).toStrictEqual({
    provider: null,
    problem:
      'target "box" reads its impd token from ATC_TEST_IMP_TOKEN, which is unset or empty in the daemon\'s environment',
  });
});

test('it reports a target whose tokenEnv is not a non-empty string, without a provider', () => {
  const built = buildImpProvider('box', { url: 'http://127.0.0.1:9', tokenEnv: 7 }, '1.0.0', {});

  expect(built).toStrictEqual({
    provider: null,
    problem: 'target "box" must give tokenEnv as a non-empty string',
  });
});

test('it builds an imp provider for a target whose token file holds a token', () => {
  const ctx = setupTest();
  const tokenPath = join(ctx.dir, 'imp-token');

  writeFileSync(tokenPath, 'file-token\n');

  const built = buildImpProvider(
    'box',
    { url: 'http://127.0.0.1:9', tokenFile: tokenPath },
    '1.0.0',
    {},
  );

  expect(built.problem).toBeNull();
  expect(built.provider).toBeInstanceOf(ImpProvider);
});

test('it reports a target that gives both tokenEnv and tokenFile, without a provider', () => {
  const ctx = setupTest();
  const tokenPath = join(ctx.dir, 'imp-token');

  writeFileSync(tokenPath, 'file-token\n');

  const built = buildImpProvider(
    'box',
    { url: 'http://127.0.0.1:9', tokenEnv: 'ATC_TEST_IMP_TOKEN', tokenFile: tokenPath },
    '1.0.0',
    { ATC_TEST_IMP_TOKEN: 'token-value' },
  );

  expect(built).toStrictEqual({
    provider: null,
    problem: 'target "box" must give its impd token through tokenEnv or tokenFile, not both',
  });
});

test('it reports a target whose token file is empty, without a provider', () => {
  const ctx = setupTest();
  const tokenPath = join(ctx.dir, 'imp-token');

  writeFileSync(tokenPath, '\n');

  const built = buildImpProvider(
    'box',
    { url: 'http://127.0.0.1:9', tokenFile: tokenPath },
    '1.0.0',
    {},
  );

  expect(built).toStrictEqual({
    provider: null,
    problem: `target "box" reads its impd token from a file it cannot use: the impd token file ${tokenPath} is empty`,
  });
});

test('it reports a target whose token file is missing, without a provider', () => {
  const ctx = setupTest();

  const built = buildImpProvider(
    'box',
    { url: 'http://127.0.0.1:9', tokenFile: join(ctx.dir, 'imp-token') },
    '1.0.0',
    {},
  );

  expect(built).toStrictEqual({
    provider: null,
    problem: `target "box" reads its impd token from a file it cannot use: cannot read the impd token file ${join(ctx.dir, 'imp-token')}: ENOENT`,
  });
});

test('it reports a target whose tokenFile is not a non-empty string, without a provider', () => {
  const built = buildImpProvider('box', { url: 'http://127.0.0.1:9', tokenFile: '' }, '1.0.0', {});

  expect(built).toStrictEqual({
    provider: null,
    problem: 'target "box" must give tokenFile as a non-empty string',
  });
});

test('it builds an imp provider that names imps under atc- when the target sets no impPrefix', () => {
  const built = buildImpProvider('box', { url: 'http://127.0.0.1:9' }, '1.0.0', {});

  invariant(built.provider !== null, 'expected an imp provider');

  expect(built.provider.impPrefix).toBe('atc-');
});

test("it builds an imp provider that names imps under the target's impPrefix", () => {
  const built = buildImpProvider(
    'box',
    { url: 'http://127.0.0.1:9', impPrefix: 'harness-' },
    '1.0.0',
    {},
  );

  invariant(built.provider !== null, 'expected an imp provider');

  expect(built.provider.impPrefix).toBe('harness-');
  expect(built.provider.getImpName('s1')).toBe('harness-s1');
});

test('it builds an imp provider that refuses a changed auth selection when the target leaves rebindChangedAuth unset', () => {
  const built = buildImpProvider('box', { url: 'http://127.0.0.1:9' }, '1.0.0', {});

  invariant(built.provider !== null, 'expected an imp provider');

  expect(built.provider.rebindChangedAuth).toBe(false);
});

test('it builds an imp provider that rebinds a changed auth selection when the target sets rebindChangedAuth', () => {
  const built = buildImpProvider(
    'box',
    { url: 'http://127.0.0.1:9', rebindChangedAuth: true },
    '1.0.0',
    {},
  );

  invariant(built.provider !== null, 'expected an imp provider');

  expect(built.provider.rebindChangedAuth).toBe(true);
});

test('it reports a target whose rebindChangedAuth is not a boolean, without a provider', () => {
  const built = buildImpProvider(
    'box',
    { url: 'http://127.0.0.1:9', rebindChangedAuth: 'yes' },
    '1.0.0',
    {},
  );

  expect(built).toStrictEqual({
    provider: null,
    problem: 'target "box" must give rebindChangedAuth as true or false',
  });
});

test.each([
  [''],
  ['*'],
  ['atc-*'],
  ['Atc-'],
  ['1atc-'],
  ['atc_'],
  ['atc.'],
  ['harnessatc-x'],
  [42],
])('it reports a target whose impPrefix is %p, without a provider', (impPrefix) => {
  expect(
    buildImpProvider('box', { url: 'http://127.0.0.1:9', impPrefix }, '1.0.0', {}),
  ).toStrictEqual({
    provider: null,
    problem:
      'target "box" must give impPrefix as a lowercase letter followed by up to 10 lowercase letters, digits or hyphens, so every imp name it builds is one impd accepts',
  });
});
